import {
  BranchRole,
  buildPromptMessagesFromLeafToRoot,
} from './branch-context-store.js';
import { formatUser } from './message-extractor.js';

/**
 * Persistent storage for Telegram Business (Secretary Mode):
 * - `business_connections`: active/disabled connections & granted BusinessBotRights
 * - `business_messages`: isolated per-connection private chat history (bounded by depth, chars & TTL)
 * - `business_chat_states`: per-chat pause/resume toggles managed via "Manage Bot" deep link
 *
 * Automatically falls back to an in-memory mirror if SQLite tables have not been migrated yet.
 */

export function makeBusinessMessageKey(businessConnectionId, chatId, messageId) {
  return `${businessConnectionId}:${chatId}:${messageId}`;
}

export function makeBusinessChatStateKey(userId, chatId) {
  return `${userId}:${chatId}`;
}

export function normalizeBusinessConnection(connection, nowFn = () => Date.now()) {
  if (!connection || typeof connection.id !== 'string' || !connection.id.trim()) {
    throw new TypeError('BusinessConnection must have a non-empty string id');
  }
  const userId = Number(connection.user?.id);
  const userChatId = Number(connection.user_chat_id);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(userChatId)) {
    throw new TypeError('BusinessConnection must have numeric user.id and user_chat_id');
  }

  return {
    id: connection.id.trim(),
    userId,
    userChatId,
    userLabel: formatUser(connection.user),
    isEnabled: Boolean(connection.is_enabled),
    canReply: Boolean(connection.rights?.can_reply ?? connection.can_reply),
    canReadMessages: Boolean(connection.rights?.can_read_messages),
    updatedAt: nowFn(),
  };
}

function hydrateConnectionRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: Number(row.userId),
    userChatId: Number(row.userChatId),
    userLabel: row.userLabel ?? 'Пользователь',
    isEnabled: Boolean(row.isEnabled),
    canReply: Boolean(row.canReply),
    canReadMessages: Boolean(row.canReadMessages),
    updatedAt: Number(row.updatedAt),
  };
}

/**
 * Pure in-memory business store for unit tests and pre-migration fallback.
 */
export function createInMemoryBusinessStore(config, nowFn = () => Date.now()) {
  const connections = new Map();
  const messages = new Map();
  const chatStates = new Map();

  function evictExpiredMessages() {
    const cutoff = nowFn() - config.branchCacheTtlMs;
    for (const [key, entry] of messages) {
      if (entry.createdAt < cutoff) {
        messages.delete(key);
      }
    }
  }

  function evictOverflowMessages() {
    const maxSize = config.branchCacheMaxSize;
    while (messages.size > maxSize) {
      const oldestKey = messages.keys().next().value;
      messages.delete(oldestKey);
    }
  }

  return {
    async upsertConnection(connection) {
      const normalized = normalizeBusinessConnection(connection, nowFn);
      connections.set(normalized.id, normalized);
      return { connection: normalized, persisted: true };
    },

    async getConnection(businessConnectionId) {
      return connections.get(businessConnectionId) ?? null;
    },

    async getConnectionsByUser(userId) {
      const result = [];
      for (const conn of connections.values()) {
        if (conn.userId === userId) {
          result.push(conn);
        }
      }
      result.sort((a, b) => b.updatedAt - a.updatedAt);
      return result;
    },

    async isChatPaused(userId, chatId) {
      const state = chatStates.get(makeBusinessChatStateKey(userId, chatId));
      return Boolean(state?.paused);
    },

    async setChatPaused(userId, chatId, paused) {
      const key = makeBusinessChatStateKey(userId, chatId);
      chatStates.set(key, {
        stateKey: key,
        userId,
        chatId,
        paused: Boolean(paused),
        updatedAt: nowFn(),
      });
      return { persisted: true };
    },

    async countPausedChats(userId) {
      let count = 0;
      for (const state of chatStates.values()) {
        if (state.userId === userId && state.paused) {
          count += 1;
        }
      }
      return count;
    },

    async hasMessage(businessConnectionId, chatId, messageId) {
      evictExpiredMessages();
      return messages.has(makeBusinessMessageKey(businessConnectionId, chatId, messageId));
    },

    async recordMessage(node) {
      evictExpiredMessages();
      const entryKey = makeBusinessMessageKey(
        node.businessConnectionId,
        node.chatId,
        node.messageId
      );
      const entry = {
        entryKey,
        businessConnectionId: node.businessConnectionId,
        chatId: node.chatId,
        messageId: node.messageId,
        role: node.role === BranchRole.ASSISTANT ? BranchRole.ASSISTANT : BranchRole.USER,
        authorLabel: node.authorLabel ?? null,
        text: node.text,
        createdAt: typeof node.createdAt === 'number' ? node.createdAt : nowFn(),
      };
      if (messages.has(entryKey)) {
        messages.delete(entryKey);
      }
      messages.set(entryKey, entry);
      evictOverflowMessages();
    },

    async updateMessageText(businessConnectionId, chatId, messageId, text) {
      evictExpiredMessages();
      const entryKey = makeBusinessMessageKey(businessConnectionId, chatId, messageId);
      const existing = messages.get(entryKey);
      if (!existing) {
        return false;
      }
      messages.set(entryKey, { ...existing, text });
      return true;
    },

    async deleteMessages(businessConnectionId, chatId, messageIds) {
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return 0;
      }
      let deleted = 0;
      for (const messageId of messageIds) {
        const key = makeBusinessMessageKey(businessConnectionId, chatId, messageId);
        if (messages.delete(key)) {
          deleted += 1;
        }
      }
      return deleted;
    },

    async clearChatHistory(businessConnectionId, chatId) {
      let deleted = 0;
      for (const [key, entry] of messages) {
        if (entry.businessConnectionId === businessConnectionId && entry.chatId === chatId) {
          messages.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },

    async buildPromptMessages(businessConnectionId, chatId, systemPromptOverride) {
      evictExpiredMessages();
      const activePrompt =
        typeof systemPromptOverride === 'string' && systemPromptOverride.trim().length > 0
          ? systemPromptOverride.trim()
          : config.secretarySystemPrompt;

      const matching = [];
      for (const entry of messages.values()) {
        if (entry.businessConnectionId === businessConnectionId && entry.chatId === chatId) {
          matching.push(entry);
        }
      }

      // Sort newest-first so buildPromptMessagesFromLeafToRoot preserves newest messages within budget
      matching.sort((a, b) => b.createdAt - a.createdAt || b.messageId - a.messageId);
      const bounded = matching.slice(0, config.secretaryMaxHistory);

      return buildPromptMessagesFromLeafToRoot(
        bounded,
        activePrompt,
        config.secretaryMaxContextChars
      );
    },
  };
}

/**
 * SQLite-backed business store using injected Telegram Serverless `sdk/db` primitives.
 */
export function createSqliteBusinessStore({
  db,
  tables,
  ops,
  config,
  nowFn = () => Date.now(),
  logger = console,
}) {
  const { connections, messages, chatStates } = tables;
  const { eq, and, lt, desc } = ops;
  const fallback = createInMemoryBusinessStore(config, nowFn);
  let warnedFallback = false;

  function warnFallback(operation, err) {
    if (warnedFallback) {
      return;
    }
    warnedFallback = true;
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      `SQLite business store ${operation} failed (${detail}); falling back to in-memory cache. ` +
        'Run `npx tgcloud migrate` to enable persistent Secretary Mode storage.'
    );
  }

  async function pruneExpiredMessages() {
    const cutoff = nowFn() - config.branchCacheTtlMs;
    await db.delete(messages).where(lt(messages.createdAt, cutoff)).run();
  }

  return {
    async upsertConnection(connection) {
      const { connection: normalized } = await fallback.upsertConnection(connection);

      try {
        await db
          .insert(connections)
          .values(normalized)
          .onConflictDoUpdate({
            target: connections.id,
            set: {
              userId: normalized.userId,
              userChatId: normalized.userChatId,
              userLabel: normalized.userLabel,
              isEnabled: normalized.isEnabled,
              canReply: normalized.canReply,
              canReadMessages: normalized.canReadMessages,
              updatedAt: normalized.updatedAt,
            },
          })
          .run();
        return { connection: normalized, persisted: true };
      } catch (err) {
        warnFallback('upsertConnection', err);
        return { connection: normalized, persisted: false };
      }
    },

    async getConnection(businessConnectionId) {
      try {
        const row = await db
          .select()
          .from(connections)
          .where(eq(connections.id, businessConnectionId))
          .get();
        return hydrateConnectionRow(row);
      } catch (err) {
        warnFallback('getConnection', err);
        return fallback.getConnection(businessConnectionId);
      }
    },

    async getConnectionsByUser(userId) {
      try {
        const rows = await db
          .select()
          .from(connections)
          .where(eq(connections.userId, userId))
          .orderBy(desc(connections.updatedAt))
          .all();
        return Array.isArray(rows) ? rows.map(hydrateConnectionRow) : [];
      } catch (err) {
        warnFallback('getConnectionsByUser', err);
        return fallback.getConnectionsByUser(userId);
      }
    },

    async isChatPaused(userId, chatId) {
      try {
        const row = await db
          .select()
          .from(chatStates)
          .where(eq(chatStates.stateKey, makeBusinessChatStateKey(userId, chatId)))
          .get();
        return Boolean(row?.paused);
      } catch (err) {
        warnFallback('isChatPaused', err);
        return fallback.isChatPaused(userId, chatId);
      }
    },

    async setChatPaused(userId, chatId, paused) {
      const normalizedPaused = Boolean(paused);
      const updatedAt = nowFn();
      const stateKey = makeBusinessChatStateKey(userId, chatId);
      await fallback.setChatPaused(userId, chatId, normalizedPaused);

      try {
        await db
          .insert(chatStates)
          .values({
            stateKey,
            userId,
            chatId,
            paused: normalizedPaused,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: chatStates.stateKey,
            set: {
              paused: normalizedPaused,
              updatedAt,
            },
          })
          .run();
        return { persisted: true };
      } catch (err) {
        warnFallback('setChatPaused', err);
        return { persisted: false };
      }
    },

    async countPausedChats(userId) {
      try {
        const rows = await db
          .select()
          .from(chatStates)
          .where(and(eq(chatStates.userId, userId), eq(chatStates.paused, true)))
          .all();
        return Array.isArray(rows) ? rows.length : 0;
      } catch (err) {
        warnFallback('countPausedChats', err);
        return fallback.countPausedChats(userId);
      }
    },

    async hasMessage(businessConnectionId, chatId, messageId) {
      try {
        const cutoff = nowFn() - config.branchCacheTtlMs;
        const row = await db
          .select()
          .from(messages)
          .where(eq(messages.entryKey, makeBusinessMessageKey(businessConnectionId, chatId, messageId)))
          .get();
        return row != null && row.createdAt >= cutoff;
      } catch (err) {
        warnFallback('hasMessage', err);
        return fallback.hasMessage(businessConnectionId, chatId, messageId);
      }
    },

    async recordMessage(node) {
      const createdAt = typeof node.createdAt === 'number' ? node.createdAt : nowFn();
      const entry = {
        entryKey: makeBusinessMessageKey(node.businessConnectionId, node.chatId, node.messageId),
        businessConnectionId: node.businessConnectionId,
        chatId: node.chatId,
        messageId: node.messageId,
        role: node.role === BranchRole.ASSISTANT ? BranchRole.ASSISTANT : BranchRole.USER,
        authorLabel: node.authorLabel ?? null,
        text: node.text,
        createdAt,
      };
      await fallback.recordMessage(entry);

      try {
        await pruneExpiredMessages();
        await db
          .insert(messages)
          .values(entry)
          .onConflictDoUpdate({
            target: messages.entryKey,
            set: {
              role: entry.role,
              authorLabel: entry.authorLabel,
              text: entry.text,
              createdAt: entry.createdAt,
            },
          })
          .run();
      } catch (err) {
        warnFallback('recordMessage', err);
      }
    },

    async updateMessageText(businessConnectionId, chatId, messageId, text) {
      await fallback.updateMessageText(businessConnectionId, chatId, messageId, text);
      try {
        const entryKey = makeBusinessMessageKey(businessConnectionId, chatId, messageId);
        const existing = await db
          .select()
          .from(messages)
          .where(eq(messages.entryKey, entryKey))
          .get();
        if (!existing) {
          return false;
        }
        await db.update(messages).set({ text }).where(eq(messages.entryKey, entryKey)).run();
        return true;
      } catch (err) {
        warnFallback('updateMessageText', err);
        return false;
      }
    },

    async deleteMessages(businessConnectionId, chatId, messageIds) {
      await fallback.deleteMessages(businessConnectionId, chatId, messageIds);
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return 0;
      }
      try {
        let deleted = 0;
        for (const messageId of messageIds) {
          const entryKey = makeBusinessMessageKey(businessConnectionId, chatId, messageId);
          await db.delete(messages).where(eq(messages.entryKey, entryKey)).run();
          deleted += 1;
        }
        return deleted;
      } catch (err) {
        warnFallback('deleteMessages', err);
        return 0;
      }
    },

    async clearChatHistory(businessConnectionId, chatId) {
      await fallback.clearChatHistory(businessConnectionId, chatId);
      try {
        await db
          .delete(messages)
          .where(
            and(
              eq(messages.businessConnectionId, businessConnectionId),
              eq(messages.chatId, chatId)
            )
          )
          .run();
        return 1;
      } catch (err) {
        warnFallback('clearChatHistory', err);
        return 0;
      }
    },

    async buildPromptMessages(businessConnectionId, chatId, systemPromptOverride) {
      const activePrompt =
        typeof systemPromptOverride === 'string' && systemPromptOverride.trim().length > 0
          ? systemPromptOverride.trim()
          : config.secretarySystemPrompt;

      try {
        const cutoff = nowFn() - config.branchCacheTtlMs;
        const rows = await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.businessConnectionId, businessConnectionId),
              eq(messages.chatId, chatId)
            )
          )
          .orderBy(desc(messages.createdAt), desc(messages.messageId))
          .limit(config.secretaryMaxHistory)
          .all();

        const validRows = Array.isArray(rows)
          ? rows.filter((row) => row && row.createdAt >= cutoff)
          : [];

        return buildPromptMessagesFromLeafToRoot(
          validRows,
          activePrompt,
          config.secretaryMaxContextChars
        );
      } catch (err) {
        warnFallback('buildPromptMessages', err);
        return fallback.buildPromptMessages(businessConnectionId, chatId, activePrompt);
      }
    },
  };
}
