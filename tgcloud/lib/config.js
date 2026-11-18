/**
 * Default system prompt and normalized runtime configuration for AnsweringBot.
 */

export const DEFAULT_SYSTEM_PROMPT =
  'Ты острый на язык, но толковый участник группового чата Telegram (твоё имя — Подсолнух). ' +
  'Если тебе задают нормальный или деловой вопрос (в том числе по пересланному сообщению) — ' +
  'отвечай максимально кратко, точно и по существу на языке вопроса, без лишних вступлений и воды. ' +
  'Если к тебе обращаются с наездом, троллингом, грубостью, чепухой или матом — не извиняйся, ' +
  'не читай мораль и не проси общаться вежливо; отвечай так же резко, дерзко и с жёстким ' +
  'сарказмом в тон собеседнику, зеркаля его подачу коротким ответом.';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-chat';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';
export const DEFAULT_BRANCH_MAX_DEPTH = 8;
export const DEFAULT_BRANCH_MAX_CONTEXT_CHARS = 6000;
export const DEFAULT_BRANCH_CACHE_MAX_SIZE = 2000;
export const DEFAULT_BRANCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeIdSet(raw, { positiveOnly = false } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return new Set();
  }
  const items =
    typeof raw === 'string'
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number(s))
      : typeof raw === 'number'
        ? [raw]
        : Array.from(raw, (v) => Number(v));

  return new Set(
    items.filter((id) => Number.isSafeInteger(id) && (!positiveOnly || id > 0))
  );
}

function normalizeAdminUserIds(adminUserIds, ownerId) {
  const merged = new Set();
  for (const id of normalizeIdSet(adminUserIds, { positiveOnly: true })) {
    merged.add(id);
  }
  for (const id of normalizeIdSet(ownerId, { positiveOnly: true })) {
    merged.add(id);
  }
  return merged;
}

function normalizePositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

/**
 * Creates an immutable normalized configuration object.
 */
export function createConfig(overrides = {}) {
  const systemPrompt =
    typeof overrides.systemPrompt === 'string' && overrides.systemPrompt.trim().length > 0
      ? overrides.systemPrompt.trim()
      : DEFAULT_SYSTEM_PROMPT;

  const openRouterModel =
    typeof overrides.openRouterModel === 'string' && overrides.openRouterModel.trim().length > 0
      ? overrides.openRouterModel.trim()
      : DEFAULT_OPENROUTER_MODEL;

  const geminiModel =
    typeof overrides.geminiModel === 'string' && overrides.geminiModel.trim().length > 0
      ? overrides.geminiModel.trim()
      : DEFAULT_GEMINI_MODEL;

  const openRouterBaseUrl =
    typeof overrides.openRouterBaseUrl === 'string' && overrides.openRouterBaseUrl.trim().length > 0
      ? overrides.openRouterBaseUrl.trim()
      : DEFAULT_OPENROUTER_BASE_URL;

  const geminiBaseUrl =
    typeof overrides.geminiBaseUrl === 'string' && overrides.geminiBaseUrl.trim().length > 0
      ? overrides.geminiBaseUrl.trim()
      : DEFAULT_GEMINI_BASE_URL;

  const rawBotId = overrides.botId;
  const botId =
    rawBotId !== null && rawBotId !== undefined && Number.isSafeInteger(Number(rawBotId))
      ? Number(rawBotId)
      : null;

  const botUsername =
    typeof overrides.botUsername === 'string'
      ? overrides.botUsername.trim().replace(/^@/, '')
      : '';

  return Object.freeze({
    enabled: overrides.enabled !== false,
    allowedChatIds: normalizeIdSet(overrides.allowedChatIds),
    adminUserIds: normalizeAdminUserIds(overrides.adminUserIds, overrides.ownerId),
    systemPrompt,
    branchMaxDepth: normalizePositiveInt(overrides.branchMaxDepth, DEFAULT_BRANCH_MAX_DEPTH),
    branchMaxContextChars: normalizePositiveInt(
      overrides.branchMaxContextChars,
      DEFAULT_BRANCH_MAX_CONTEXT_CHARS
    ),
    branchCacheMaxSize: normalizePositiveInt(
      overrides.branchCacheMaxSize,
      DEFAULT_BRANCH_CACHE_MAX_SIZE
    ),
    branchCacheTtlMs: normalizePositiveInt(
      overrides.branchCacheTtlMs,
      DEFAULT_BRANCH_CACHE_TTL_MS
    ),
    openRouterApiKey: String(overrides.openRouterApiKey ?? '').trim(),
    openRouterBaseUrl,
    openRouterModel,
    geminiApiKey: String(overrides.geminiApiKey ?? '').trim(),
    geminiBaseUrl,
    geminiModel,
    botId,
    botUsername,
  });
}
