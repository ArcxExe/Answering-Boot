/**
 * Persistent bot settings store (dynamic system prompt) backed by Telegram Serverless SQLite (`sdk/db`).
 * Automatically falls back to an in-memory map if the `bot_settings` table has not been migrated yet.
 */

export const SYSTEM_PROMPT_KEY = 'system_prompt';

/**
 * Simple in-memory settings store useful for unit tests and local fallback.
 */
export function createInMemorySettingsStore(initialSystemPrompt = null) {
  const values = new Map();
  if (typeof initialSystemPrompt === 'string' && initialSystemPrompt.trim().length > 0) {
    values.set(SYSTEM_PROMPT_KEY, initialSystemPrompt.trim());
  }

  return {
    async getSystemPrompt() {
      const value = values.get(SYSTEM_PROMPT_KEY);
      return typeof value === 'string' && value.trim().length > 0 ? value : null;
    },

    async setSystemPrompt(prompt) {
      const normalized = String(prompt ?? '').trim();
      if (normalized.length === 0) {
        throw new RangeError('System prompt must not be empty');
      }
      values.set(SYSTEM_PROMPT_KEY, normalized);
      return { persisted: true };
    },

    async resetSystemPrompt() {
      values.delete(SYSTEM_PROMPT_KEY);
      return { persisted: true };
    },
  };
}

/**
 * Creates a SQLite-backed settings store using injected `sdk/db` primitives.
 */
export function createSqliteSettingsStore({
  db,
  table,
  eq,
  nowFn = () => Date.now(),
  logger = console,
}) {
  const fallback = new Map();
  let warnedFallback = false;

  function warnFallback(operation, err) {
    if (warnedFallback) {
      return;
    }
    warnedFallback = true;
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      `SQLite bot_settings ${operation} failed (${detail}); falling back to in-memory settings. ` +
        'Run `npx tgcloud migrate` to persist custom prompts.'
    );
  }

  return {
    async getSystemPrompt() {
      try {
        const row = await db
          .select()
          .from(table)
          .where(eq(table.key, SYSTEM_PROMPT_KEY))
          .get();
        if (row && typeof row.value === 'string' && row.value.trim().length > 0) {
          return row.value.trim();
        }
        return null;
      } catch (err) {
        warnFallback('getSystemPrompt', err);
        const value = fallback.get(SYSTEM_PROMPT_KEY);
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
      }
    },

    async setSystemPrompt(prompt) {
      const normalized = String(prompt ?? '').trim();
      if (normalized.length === 0) {
        throw new RangeError('System prompt must not be empty');
      }

      const updatedAt = nowFn();
      fallback.set(SYSTEM_PROMPT_KEY, normalized);

      try {
        await db
          .insert(table)
          .values({
            key: SYSTEM_PROMPT_KEY,
            value: normalized,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: table.key,
            set: {
              value: normalized,
              updatedAt,
            },
          })
          .run();
        return { persisted: true };
      } catch (err) {
        warnFallback('setSystemPrompt', err);
        return { persisted: false };
      }
    },

    async resetSystemPrompt() {
      fallback.delete(SYSTEM_PROMPT_KEY);

      try {
        await db.delete(table).where(eq(table.key, SYSTEM_PROMPT_KEY)).run();
        return { persisted: true };
      } catch (err) {
        warnFallback('resetSystemPrompt', err);
        return { persisted: false };
      }
    },
  };
}
