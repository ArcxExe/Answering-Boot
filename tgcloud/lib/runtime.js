import { api, db, fetch } from 'sdk';
import { and, desc, eq, lt } from 'sdk/db';
import {
  botSettings,
  branchNodes,
  businessChatStates,
  businessConnections,
  businessMessages,
} from '../schema.js';
import { createBotProcessor } from './bot-processor.js';
import { createSqliteBusinessStore } from './business-store.js';
import { createConfig } from './config.js';
import { createGeminiClient, createOpenRouterClient } from './llm-client.js';
import { createLlmFallbackService } from './llm-fallback.js';
import { SECRETS } from './secrets.js';
import { createSecretaryProcessor } from './secretary-processor.js';
import { createSqliteSettingsStore } from './settings-store.js';
import { createSqliteBranchContextStore } from './sqlite-branch-context-store.js';

/**
 * Shared Telegram Serverless runtime wiring imported by all update handlers in `tgcloud/handlers/`.
 */
export const config = createConfig(SECRETS);

export const contextStore = createSqliteBranchContextStore({
  db,
  table: branchNodes,
  eq,
  lt,
  config,
});

export const settingsStore = createSqliteSettingsStore({
  db,
  table: botSettings,
  eq,
});

export const businessStore = createSqliteBusinessStore({
  db,
  tables: {
    connections: businessConnections,
    messages: businessMessages,
    chatStates: businessChatStates,
  },
  ops: { eq, and, lt, desc },
  config,
});

const openRouterClient = createOpenRouterClient({
  apiKey: config.openRouterApiKey,
  baseUrl: config.openRouterBaseUrl,
  model: config.openRouterModel,
  fetchFn: fetch,
});

const geminiClient = createGeminiClient({
  apiKey: config.geminiApiKey,
  baseUrl: config.geminiBaseUrl,
  model: config.geminiModel,
  fetchFn: fetch,
});

const searchGeminiClient = config.geminiApiKey
  ? createGeminiClient({
      apiKey: config.geminiApiKey,
      baseUrl: config.geminiBaseUrl,
      model: config.geminiModel,
      fetchFn: fetch,
      enableGoogleSearch: true,
    })
  : null;

export const llmService = createLlmFallbackService({
  primaryClient: openRouterClient,
  fallbackClient: geminiClient,
});

export const secretaryProcessor = createSecretaryProcessor({
  api,
  config,
  businessStore,
  settingsStore,
  llmService,
});

export const processor = createBotProcessor({
  api,
  config,
  contextStore,
  settingsStore,
  llmService,
  searchLlmClient: searchGeminiClient,
  secretaryProcessor,
});
