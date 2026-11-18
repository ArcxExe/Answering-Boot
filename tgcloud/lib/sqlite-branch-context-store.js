import {
  BranchContextStore,
  buildPromptMessagesFromLeafToRoot,
  makeNodeKey,
} from './branch-context-store.js';

/**
 * Persistent reply-branch context store backed by Telegram Serverless SQLite (`sdk/db`).
 * Automatically falls back to an in-memory store if the DB table has not been migrated yet.
 */
export function createSqliteBranchContextStore({
  db,
  table,
  eq,
  lt,
  config,
  nowFn = () => Date.now(),
  logger = console,
}) {
  const fallbackStore = new BranchContextStore(config, nowFn);
  let warnedFallback = false;

  function warnFallback(operation, err) {
    if (warnedFallback) {
      return;
    }
    warnedFallback = true;
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      `SQLite branch_nodes ${operation} failed (${detail}); falling back to in-memory cache. ` +
        'Run `npx tgcloud migrate` to enable persistent reply memory.'
    );
  }

  async function pruneExpired() {
    const cutoff = nowFn() - config.branchCacheTtlMs;
    await db.delete(table).where(lt(table.createdAt, cutoff)).run();
  }

  return {
    async recordNode(node) {
      const createdAt = typeof node.createdAt === 'number' ? node.createdAt : nowFn();
      const entry = {
        nodeKey: makeNodeKey(node.chatId, node.messageId),
        chatId: node.chatId,
        messageId: node.messageId,
        parentMessageId: node.parentMessageId ?? null,
        role: node.role,
        authorLabel: node.authorLabel ?? null,
        forwardedFrom: node.forwardedFrom ?? null,
        text: node.text,
        createdAt,
      };

      // Keep in-memory mirror updated in case of fallback
      fallbackStore.recordNode(entry);

      try {
        await pruneExpired();
        await db
          .insert(table)
          .values(entry)
          .onConflictDoUpdate({
            target: table.nodeKey,
            set: {
              parentMessageId: entry.parentMessageId,
              role: entry.role,
              authorLabel: entry.authorLabel,
              forwardedFrom: entry.forwardedFrom,
              text: entry.text,
              createdAt: entry.createdAt,
            },
          })
          .run();
      } catch (err) {
        warnFallback('recordNode', err);
      }
    },

    async contains(chatId, messageId) {
      try {
        const cutoff = nowFn() - config.branchCacheTtlMs;
        const row = await db
          .select()
          .from(table)
          .where(eq(table.nodeKey, makeNodeKey(chatId, messageId)))
          .get();
        return row != null && row.createdAt >= cutoff;
      } catch (err) {
        warnFallback('contains', err);
        return fallbackStore.contains(chatId, messageId);
      }
    },

    async buildPromptMessages(chatId, leafMessageId, systemPromptOverride) {
      const activeSystemPrompt =
        typeof systemPromptOverride === 'string' && systemPromptOverride.trim().length > 0
          ? systemPromptOverride.trim()
          : config.systemPrompt;

      try {
        const cutoff = nowFn() - config.branchCacheTtlMs;
        const leafToRoot = [];
        const visitedIds = new Set();
        let cursorId = leafMessageId;
        const maxDepth = config.branchMaxDepth;

        while (cursorId != null && leafToRoot.length < maxDepth && !visitedIds.has(cursorId)) {
          visitedIds.add(cursorId);
          const row = await db
            .select()
            .from(table)
            .where(eq(table.nodeKey, makeNodeKey(chatId, cursorId)))
            .get();

          if (!row || row.createdAt < cutoff) {
            break;
          }

          leafToRoot.push(row);
          cursorId = row.parentMessageId;
        }

        return buildPromptMessagesFromLeafToRoot(
          leafToRoot,
          activeSystemPrompt,
          config.branchMaxContextChars
        );
      } catch (err) {
        warnFallback('buildPromptMessages', err);
        return fallbackStore.buildPromptMessages(chatId, leafMessageId, activeSystemPrompt);
      }
    },
  };
}
