import { api, fetch } from 'sdk';
import { createBotProcessor } from '../lib/bot-processor.js';
import { BranchContextStore } from '../lib/branch-context-store.js';
import { createConfig } from '../lib/config.js';
import { createGeminiClient, createOpenRouterClient } from '../lib/llm-client.js';
import { createLlmFallbackService } from '../lib/llm-fallback.js';
import { SECRETS } from '../lib/secrets.js';

const config = createConfig(SECRETS);
const contextStore = new BranchContextStore(config);

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
