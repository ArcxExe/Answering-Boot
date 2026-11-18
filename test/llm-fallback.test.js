import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGeminiRequestBody,
  createGeminiClient,
  createOpenRouterClient,
} from '../tgcloud/lib/llm-client.js';
import { createLlmFallbackService } from '../tgcloud/lib/llm-fallback.js';

const sampleMessages = [{ role: 'user', content: 'Когда день рождения у codex?' }];
const silentLogger = { warn() {}, error() {}, debug() {} };

describe('llm-fallback', () => {
  it('returns primary OpenRouter answer when successful', async () => {
    let fallbackCalled = false;
    const primaryClient = { async ask() { return '  Короткий ответ  '; } };
    const fallbackClient = {
      async ask() {
        fallbackCalled = true;
        return 'Ответ от Gemini';
      },
    };

    const service = createLlmFallbackService({
      primaryClient,
      fallbackClient,
      logger: silentLogger,
    });

    const answer = await service.generateAnswer(sampleMessages);
    assert.equal(answer, 'Короткий ответ');
    assert.equal(fallbackCalled, false);
  });

  it('falls back to Gemini when primary throws an error', async () => {
    const primaryClient = {
      async ask() {
        throw new Error('429 Too Many Requests');
      },
    };
    const fallbackClient = { async ask() { return 'Ответ от Gemini'; } };

    const service = createLlmFallbackService({
      primaryClient,
      fallbackClient,
      logger: silentLogger,
    });

    const answer = await service.generateAnswer(sampleMessages);
    assert.equal(answer, 'Ответ от Gemini');
  });

  it('falls back to Gemini when primary returns blank text', async () => {
    const primaryClient = { async ask() { return '   '; } };
    const fallbackClient = { async ask() { return 'Ответ от Gemini'; } };

    const service = createLlmFallbackService({
      primaryClient,
      fallbackClient,
      logger: silentLogger,
    });

    const answer = await service.generateAnswer(sampleMessages);
    assert.equal(answer, 'Ответ от Gemini');
  });

  it('throws when both providers fail', async () => {
    const primaryClient = {
      async ask() {
        throw new Error('OpenRouter rate limit');
      },
    };
    const fallbackClient = {
      async ask() {
        throw new Error('Gemini unavailable');
      },
    };

    const service = createLlmFallbackService({
      primaryClient,
      fallbackClient,
      logger: silentLogger,
    });

    await assert.rejects(() => service.generateAnswer(sampleMessages), /LLM/);
  });
});

describe('llm-client', () => {
  it('formats OpenRouter chat completions request and parses content', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: 'Ответ OpenRouter' } }],
          };
        },
      };
    };

    const client = createOpenRouterClient({
      apiKey: 'or-key',
      baseUrl: 'https://openrouter.ai/api/v1/',
      model: 'deepseek/deepseek-chat',
      fetchFn,
    });

    const result = await client.ask([
      { role: 'system', content: 'Системный промпт' },
      { role: 'user', content: 'Привет' },
    ]);

    assert.equal(result, 'Ответ OpenRouter');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer or-key');
    const parsedBody = JSON.parse(calls[0].init.body);
    assert.equal(parsedBody.model, 'deepseek/deepseek-chat');
    assert.equal(parsedBody.messages.length, 2);
  });

  it('merges consecutive same-role turns and sets system_instruction for Gemini', () => {
    const body = buildGeminiRequestBody([
      { role: 'system', content: 'Ты Подсолнух.' },
      { role: 'user', content: '[Переслано от News]: Пост' },
      { role: 'user', content: 'Мария: когда это было?' },
      { role: 'assistant', content: 'Вчера.' },
      { role: 'user', content: 'Петр: а подробнее?' },
    ]);

    assert.deepEqual(body.system_instruction, { parts: [{ text: 'Ты Подсолнух.' }] });
    assert.equal(body.contents.length, 3);
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents[0].parts.length, 2);
    assert.equal(body.contents[1].role, 'model');
    assert.equal(body.contents[2].role, 'user');
  });

  it('calls Gemini generateContent endpoint with x-goog-api-key header', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: 'Часть 1 ' }, { text: 'Часть 2' }] } }],
          };
        },
      };
    };

    const client = createGeminiClient({
      apiKey: 'gm-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash-lite',
      fetchFn,
    });

    const result = await client.ask(sampleMessages);
    assert.equal(result, 'Часть 1 Часть 2');
    assert.equal(
      calls[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent'
    );
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'gm-key');
  });
});
