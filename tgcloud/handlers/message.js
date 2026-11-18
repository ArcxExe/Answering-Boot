import { api, db, fetch } from 'sdk';
import { eq, lt } from 'sdk/db';
import { createBotProcessor } from '../lib/bot-processor.js';
import { createConfig } from '../lib/config.js';
import { createGeminiClient, createOpenRouterClient } from '../lib/llm-client.js';
import { createLlmFallbackService } from '../lib/llm-fallback.js';
import { SECRETS } from '../lib/secrets.js';
import { createSqliteBranchContextStore } from '../lib/sqlite-branch-context-store.js';
import { branchNodes } from '../schema.js';

const config = createConfig(SECRETS);
const contextStore = createSqliteBranchContextStore({
  db,
  table: branchNodes,
  eq,
  lt,
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

const llmService = createLlmFallbackService({
  primaryClient: openRouterClient,
  fallbackClient: geminiClient,
});

const processor = createBotProcessor({
  api,
  config,
  contextStore,
  llmService,
});

/**
 * Telegram Serverless update handler for incoming `message` updates.
 */
export default async function (message) {
  try {
    await processor.processMessage(message);
  } catch (err) {
    console.error(
      `Unhandled error while processing message ${message?.message_id} in chat ${message?.chat?.id}`,
      err
    );
  }
}
