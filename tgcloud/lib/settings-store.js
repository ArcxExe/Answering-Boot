/**
 * Persistent bot settings store (dynamic system prompt) backed by Telegram Serverless SQLite (`sdk/db`).
 * Automatically falls back to an in-memory map if the `bot_settings` table has not been migrated yet.
 */

export const SYSTEM_PROMPT_KEY = 'system_prompt';
export const SECRETARY_PROMPT_KEY_PREFIX = 'secretary_prompt:';

export function makeSecretaryPromptKey(userId) {
  return `${SECRETARY_PROMPT_KEY_PREFIX}${userId}`;
}

/**
 * Simple in-memory settings store useful for unit tests and local fallback.
 */
export function createInMemorySettingsStore(initialSystemPrompt = null) {
  const values = new Map();
  if (typeof initialSystemPrompt === 'string' && initialSystemPrompt.trim().length > 0) {
    values.set(SYSTEM_PROMPT_KEY, initialSystemPrompt.trim());
  }

  async function getValue(key) {
    const value = values.get(key);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  async function setValue(key, prompt) {
    const normalized = String(prompt ?? '').trim();
    if (normalized.length === 0) {
      throw new RangeError('System prompt must not be empty');
    }
    values.set(key, normalized);
    return { persisted: true };
  }

  async function resetValue(key) {
    values.delete(key);
    return { persisted: true };
  }

  return {
    getSystemPrompt: () => getValue(SYSTEM_PROMPT_KEY),
    setSystemPrompt: (prompt) => setValue(SYSTEM_PROMPT_KEY, prompt),
    resetSystemPrompt: () => resetValue(SYSTEM_PROMPT_KEY),
    getSecretaryPrompt: (userId) => getValue(makeSecretaryPromptKey(userId)),
    setSecretaryPrompt: (userId, prompt) => setValue(makeSecretaryPromptKey(userId), prompt),
    resetSecretaryPrompt: (userId) => resetValue(makeSecretaryPromptKey(userId)),
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

  async function getByKey(key, opName) {
    try {
      const row = await db.select().from(table).where(eq(table.key, key)).get();
      if (row && typeof row.value === 'string' && row.value.trim().length > 0) {
        return row.value.trim();
      }
      return null;
    } catch (err) {
      warnFallback(opName, err);
      const value = fallback.get(key);
      return typeof value === 'string' && value.trim().length > 0 ? value : null;
    }
  }

  async function setByKey(key, prompt, opName) {
    const normalized = String(prompt ?? '').trim();
    if (normalized.length === 0) {
      throw new RangeError('System prompt must not be empty');
    }

    const updatedAt = nowFn();
    fallback.set(key, normalized);

    try {
      await db
        .insert(table)
        .values({
          key,
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
      warnFallback(opName, err);
      return { persisted: false };
    }
  }

  async function deleteByKey(key, opName) {
    fallback.delete(key);

    try {
      await db.delete(table).where(eq(table.key, key)).run();
      return { persisted: true };
    } catch (err) {
      warnFallback(opName, err);
      return { persisted: false };
    }
  }

  return {
    getSystemPrompt: () => getByKey(SYSTEM_PROMPT_KEY, 'getSystemPrompt'),
    setSystemPrompt: (prompt) => setByKey(SYSTEM_PROMPT_KEY, prompt, 'setSystemPrompt'),
    resetSystemPrompt: () => deleteByKey(SYSTEM_PROMPT_KEY, 'resetSystemPrompt'),
    getSecretaryPrompt: (userId) =>
      getByKey(makeSecretaryPromptKey(userId), 'getSecretaryPrompt'),
    setSecretaryPrompt: (userId, prompt) =>
      setByKey(makeSecretaryPromptKey(userId), prompt, 'setSecretaryPrompt'),
    resetSecretaryPrompt: (userId) =>
      deleteByKey(makeSecretaryPromptKey(userId), 'resetSecretaryPrompt'),
  };
}
