import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBotProcessor } from '../tgcloud/lib/bot-processor.js';
import { BranchContextStore } from '../tgcloud/lib/branch-context-store.js';
import { createConfig } from '../tgcloud/lib/config.js';

import { createInMemorySettingsStore } from '../tgcloud/lib/settings-store.js';

const BOT_ID = 999;
const BOT_USERNAME = 'answering_bot';
const silentLogger = { warn() {}, error() {}, debug() {} };

function createHarness({
  llmAnswers = [],
  llmError = null,
  searchAnswers = ['Найденный ответ в Google.'],
  searchError = null,
  enableSearchClient = true,
  ownerId = null,
  settingsStore = createInMemorySettingsStore(),
  preloadIdentity = true,
} = {}) {
  const config = createConfig({
    systemPrompt: 'Будь кратким.',
    ownerId,
    botId: preloadIdentity ? BOT_ID : null,
    botUsername: preloadIdentity ? BOT_USERNAME : '',
  });
  const contextStore = new BranchContextStore(config);

  const apiCalls = [];
  const llmPrompts = [];
  const searchPrompts = [];
  let nextSentId = 500;
  let answerIndex = 0;
  let searchIndex = 0;

  const api = {
    async getMe() {
      apiCalls.push({ method: 'getMe' });
      return { id: BOT_ID, username: BOT_USERNAME, is_bot: true };
    },
    async sendChatAction(params) {
      apiCalls.push({ method: 'sendChatAction', params });
      return true;
    },
    async sendMessage(params) {
      apiCalls.push({ method: 'sendMessage', params });
      const messageId = nextSentId++;
      return {
        message_id: messageId,
        chat: { id: params.chat_id, type: 'supergroup' },
        from: { id: BOT_ID, first_name: 'Bot', is_bot: true },
        text: params.text,
      };
    },
  };

  const llmService = {
    async generateAnswer(messages) {
      llmPrompts.push(messages);
      if (llmError) {
        throw llmError;
      }
      const next = llmAnswers[Math.min(answerIndex, llmAnswers.length - 1)];
      answerIndex += 1;
      return next;
    },
  };

  const searchLlmClient = enableSearchClient
    ? {
        async ask(messages) {
          searchPrompts.push(messages);
          if (searchError) {
            throw searchError;
          }
          const next = searchAnswers[Math.min(searchIndex, searchAnswers.length - 1)];
          searchIndex += 1;
          return next;
        },
      }
    : null;

  const processor = createBotProcessor({
    api,
    config,
    contextStore,
    settingsStore,
    llmService,
    searchLlmClient,
    logger: silentLogger,
  });

  return { processor, apiCalls, llmPrompts, searchPrompts, contextStore, settingsStore };
}

describe('bot-processor', () => {
  it('answers forwarded reply mention and stores bot reply', async () => {
    const { processor, apiCalls, llmPrompts, contextStore } = createHarness({
      llmAnswers: ['10 августа 2021 года.'],
    });

    const group = { id: -100500, type: 'supergroup', title: 'DevChat' };
    const forwardedPost = {
      message_id: 50,
      chat: group,
      from: { id: 10, first_name: 'Алексей', is_bot: false },
      forward_origin: {
        type: 'channel',
        chat: { id: -200, type: 'channel', title: 'OpenAI News' },
      },
      text: 'Сегодня релиз Codex...',
    };
    const incoming = {
      message_id: 51,
      chat: group,
      from: { id: 11, first_name: 'Мария', is_bot: false },
      reply_to_message: forwardedPost,
      text: '@answering_bot когда день рождения у codex',
      entities: [{ type: 'mention', offset: 0, length: 14 }],
    };

    await processor.processMessage(incoming);

    assert.equal(llmPrompts.length, 1);
    const sentToLlm = llmPrompts[0];
    assert.equal(sentToLlm.length, 3);
    assert.equal(sentToLlm[0].role, 'system');
    assert.equal(sentToLlm[1].role, 'user');
    assert.match(sentToLlm[1].content, /OpenAI News/);
    assert.match(sentToLlm[1].content, /Сегодня релиз Codex/);
    assert.equal(sentToLlm[2].role, 'user');
    assert.match(sentToLlm[2].content, /когда день рождения у codex/);
    assert.doesNotMatch(sentToLlm[2].content, /@answering_bot/);

    assert.equal(apiCalls.length, 2);
    assert.equal(apiCalls[0].method, 'sendChatAction');
    assert.equal(apiCalls[0].params.action, 'typing');
    assert.equal(apiCalls[1].method, 'sendMessage');
    assert.equal(apiCalls[1].params.chat_id, -100500);
    assert.equal(apiCalls[1].params.reply_parameters.message_id, 51);
    assert.equal(apiCalls[1].params.text, '10 августа 2021 года.');

    assert.equal(contextStore.contains(-100500, 500), true);
    const nextPrompt = contextStore.buildPromptMessages(-100500, 500);
    assert.deepEqual(nextPrompt.at(-1), { role: 'assistant', content: '10 августа 2021 года.' });
  });

  it('uses default prompt when user only mentions bot on forwarded reply', async () => {
    const { processor, llmPrompts } = createHarness({ llmAnswers: ['Краткое пояснение.'] });
    const group = { id: -100, type: 'group' };

    const incoming = {
      message_id: 11,
      chat: group,
      from: { id: 11, first_name: 'Иван', is_bot: false },
      reply_to_message: {
        message_id: 10,
        chat: group,
        caption: 'Важный анонс про JavaScript',
      },
      text: '@answering_bot',
    };

    await processor.processMessage(incoming);

    assert.equal(llmPrompts.length, 1);
    assert.match(llmPrompts[0].at(-1).content, /Дай краткий и информативный ответ/);
  });

  it('handles DM /start without calling LLM', async () => {
    const { processor, apiCalls, llmPrompts } = createHarness();

    await processor.processMessage({
      message_id: 1,
      chat: { id: 777, type: 'private' },
      from: { id: 777, first_name: 'Иван', is_bot: false },
      text: '/start',
    });

    assert.equal(llmPrompts.length, 0);
    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].method, 'sendMessage');
    assert.equal(apiCalls[0].params.chat_id, 777);
    assert.match(apiCalls[0].params.text, /@answering_bot/);
  });

  it('sends safe fallback message when both LLM providers fail', async () => {
    const { processor, apiCalls } = createHarness({
      llmError: new Error('Both failed'),
    });

    await processor.processMessage({
      message_id: 20,
      chat: { id: -100, type: 'group' },
      from: { id: 11, first_name: 'Иван', is_bot: false },
      text: '@answering_bot привет',
    });

    const sent = apiCalls.find((c) => c.method === 'sendMessage');
    assert.ok(sent);
    assert.equal(sent.params.reply_parameters.message_id, 20);
    assert.match(sent.params.text, /Не удалось получить ответ/);
  });

  it('does not call LLM when empty mention replies to media without caption', async () => {
    const { processor, apiCalls, llmPrompts } = createHarness();
    const group = { id: -100, type: 'supergroup' };

    await processor.processMessage({
      message_id: 31,
      chat: group,
      from: { id: 11, first_name: 'Мария', is_bot: false },
      reply_to_message: {
        message_id: 30,
        chat: group,
        from: { id: 10, first_name: 'Алексей', is_bot: false },
      },
      text: '@answering_bot',
    });

    assert.equal(llmPrompts.length, 0);
    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].params.reply_parameters.message_id, 31);
    assert.match(apiCalls[0].params.text, /текстов/);
  });

  it('splits long LLM answer into chained replies and stores all chunks', async () => {
    const longAnswer = 'Абзац ответа про Telegram Serverless.\n'.repeat(140); // > 4096 chars
    const { processor, apiCalls, contextStore } = createHarness({ llmAnswers: [longAnswer] });

    await processor.processMessage({
      message_id: 40,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 11, first_name: 'Мария', is_bot: false },
      text: '@answering_bot расскажи подробно',
    });

    const sentMessages = apiCalls.filter((c) => c.method === 'sendMessage');
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].params.reply_parameters.message_id, 40);
    assert.ok(sentMessages[0].params.text.length <= 4096);
    assert.equal(sentMessages[1].params.reply_parameters.message_id, 500);
    assert.ok(sentMessages[1].params.text.length <= 4096);
    assert.equal(contextStore.contains(-100, 500), true);
    assert.equal(contextStore.contains(-100, 501), true);
  });

  it('answers follow-up reply to bot message without mention preserving full branch', async () => {
    const { processor, llmPrompts } = createHarness({
      llmAnswers: ['10 августа 2021 года.', 'OpenAI.'],
    });
    const group = { id: -100, type: 'supergroup' };

    const forwarded = {
      message_id: 60,
      chat: group,
      forward_origin: {
        type: 'channel',
        chat: { id: -200, type: 'channel', title: 'TechNews' },
      },
      text: 'Релиз Codex состоялся.',
    };
    const firstQuestion = {
      message_id: 61,
      chat: group,
      from: { id: 11, first_name: 'Мария', is_bot: false },
      reply_to_message: forwarded,
      text: '@answering_bot когда?',
    };

    await processor.processMessage(firstQuestion);

    const followUp = {
      message_id: 64,
      chat: group,
      from: { id: 12, first_name: 'Петр', is_bot: false },
      reply_to_message: {
        message_id: 500, // ID returned by mock sendMessage for first answer
        chat: group,
        from: { id: BOT_ID, first_name: 'Bot', is_bot: true },
        text: '10 августа 2021 года.',
      },
      text: 'А кто разработчик?',
    };

    await processor.processMessage(followUp);

    assert.equal(llmPrompts.length, 2);
    const secondPrompt = llmPrompts[1];
    assert.equal(secondPrompt.length, 5); // system + forwarded + Q1 + A1 + Q2
    assert.match(secondPrompt[1].content, /TechNews/);
    assert.equal(secondPrompt[3].role, 'assistant');
    assert.match(secondPrompt[4].content, /А кто разработчик\?/);
  });

  it('ignores non-mentioned group chatter', async () => {
    const { processor, apiCalls, llmPrompts } = createHarness();

    await processor.processMessage({
      message_id: 70,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 11, first_name: 'Мария', is_bot: false },
      text: 'Просто сообщение в чате',
    });

    assert.equal(llmPrompts.length, 0);
    assert.equal(apiCalls.length, 0);
  });

  it('fetches and caches bot identity via getMe once when not preconfigured', async () => {
    const { processor, apiCalls } = createHarness({ preloadIdentity: false });
    const dm = { id: 777, type: 'private' };

    await processor.processMessage({
      message_id: 1,
      chat: dm,
      from: { id: 777, first_name: 'Иван', is_bot: false },
      text: '/start',
    });
    await processor.processMessage({
      message_id: 2,
      chat: dm,
      from: { id: 777, first_name: 'Иван', is_bot: false },
      text: '/start',
    });

    const getMeCalls = apiCalls.filter((c) => c.method === 'getMe');
    assert.equal(getMeCalls.length, 1);
  });

  it('allows admin by Telegram ID to view, update, and reset dynamic system prompt', async () => {
    const { processor, apiCalls, llmPrompts } = createHarness({
      ownerId: 42,
      llmAnswers: ['Ответ 1', 'Ответ 2'],
    });
    const dmAdmin = { id: 42, type: 'private' };
    const adminUser = { id: 42, first_name: 'Владелец', is_bot: false };

    // 1. Check default prompt
    await processor.processMessage({
      message_id: 1,
      chat: dmAdmin,
      from: adminUser,
      text: '/prompt',
    });
    assert.match(apiCalls.at(-1).params.text, /по умолчанию/);
    assert.match(apiCalls.at(-1).params.text, /Будь кратким\./);

    // 2. Empty /setprompt returns usage hint
    await processor.processMessage({
      message_id: 2,
      chat: dmAdmin,
      from: adminUser,
      text: '/setprompt   ',
    });
    assert.match(apiCalls.at(-1).params.text, /Укажите новый системный промпт/);

    // 3. Update prompt with multiline text
    await processor.processMessage({
      message_id: 3,
      chat: dmAdmin,
      from: adminUser,
      text: '/setprompt Ты пират.\nОтвечай коротко.',
    });
    assert.match(apiCalls.at(-1).params.text, /обновлён/);

    // 4. Subsequent chat question uses the new custom system prompt
    await processor.processMessage({
      message_id: 4,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 10, first_name: 'Мария', is_bot: false },
      text: '@answering_bot привет',
    });
    assert.equal(llmPrompts.length, 1);
    assert.equal(llmPrompts[0][0].role, 'system');
    assert.equal(llmPrompts[0][0].content, 'Ты пират.\nОтвечай коротко.');

    // 5. /prompt shows custom prompt
    await processor.processMessage({
      message_id: 5,
      chat: dmAdmin,
      from: adminUser,
      text: '/prompt',
    });
    assert.match(apiCalls.at(-1).params.text, /пользовательский/);
    assert.match(apiCalls.at(-1).params.text, /Ты пират\./);

    // 6. /resetprompt restores default system prompt
    await processor.processMessage({
      message_id: 6,
      chat: dmAdmin,
      from: adminUser,
      text: '/resetprompt',
    });
    assert.match(apiCalls.at(-1).params.text, /сброшен/);

    await processor.processMessage({
      message_id: 7,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 10, first_name: 'Мария', is_bot: false },
      text: '@answering_bot ещё вопрос',
    });
    assert.equal(llmPrompts.length, 2);
    assert.equal(llmPrompts[1][0].content, 'Будь кратким.');
  });

  it('denies non-admin prompt changes in DM and returns user ID on /id', async () => {
    const { processor, apiCalls, llmPrompts } = createHarness({ ownerId: 42 });
    const dmUser = { id: 99, type: 'private' };

    await processor.processMessage({
      message_id: 1,
      chat: dmUser,
      from: { id: 99, first_name: 'Гость', is_bot: false },
      text: '/id',
    });
    assert.equal(apiCalls.at(-1).params.text, 'Ваш Telegram ID: 99');

    await processor.processMessage({
      message_id: 2,
      chat: dmUser,
      from: { id: 99, first_name: 'Гость', is_bot: false },
      text: '/setprompt новый',
    });
    assert.match(apiCalls.at(-1).params.text, /нет доступа/);
    assert.equal(llmPrompts.length, 0);
  });

  it('routes /search to Gemini Google Search client, includes reply context, and stores branch', async () => {
    const { processor, apiCalls, llmPrompts, searchPrompts, contextStore } = createHarness({
      searchAnswers: ['Актуальный курс: 90 ₽.\n\nИсточники:\n• ЦБ РФ — https://cbr.ru/'],
    });
    const group = { id: -200, type: 'supergroup' };

    await processor.processMessage({
      message_id: 80,
      chat: group,
      from: { id: 11, first_name: 'Мария', is_bot: false },
      reply_to_message: {
        message_id: 79,
        chat: group,
        text: 'Говорят доллар сегодня по 100?',
      },
      text: '/search@answering_bot проверь курс доллара',
    });

    assert.equal(llmPrompts.length, 0);
    assert.equal(searchPrompts.length, 1);
    assert.equal(searchPrompts[0].length, 3); // system + reply parent + search query
    assert.match(searchPrompts[0][1].content, /Говорят доллар сегодня по 100/);
    assert.match(searchPrompts[0][2].content, /проверь курс доллара/);
    assert.doesNotMatch(searchPrompts[0][2].content, /\/search/);

    const sent = apiCalls.find((c) => c.method === 'sendMessage');
    assert.ok(sent);
    assert.match(sent.params.text, /Актуальный курс: 90 ₽/);
    assert.equal(contextStore.contains(-200, 500), true);
  });

  it('handles empty /search usage, missing GEMINI_API, and Gemini search errors gracefully', async () => {
    // Empty /search without reply shows usage hint
    const h1 = createHarness();
    await h1.processor.processMessage({
      message_id: 1,
      chat: { id: -200, type: 'group' },
      from: { id: 11, first_name: 'Иван', is_bot: false },
      text: '/search',
    });
    assert.equal(h1.searchPrompts.length, 0);
    assert.match(h1.apiCalls.at(-1).params.text, /Укажите запрос/);

    // Missing Gemini API client
    const h2 = createHarness({ enableSearchClient: false });
    await h2.processor.processMessage({
      message_id: 2,
      chat: { id: -200, type: 'group' },
      from: { id: 11, first_name: 'Иван', is_bot: false },
      text: '/search погода',
    });
    assert.match(h2.apiCalls.at(-1).params.text, /GEMINI_API/);

    // Gemini search throws error
    const h3 = createHarness({ searchError: new Error('Gemini 503') });
    await h3.processor.processMessage({
      message_id: 3,
      chat: { id: -200, type: 'group' },
      from: { id: 11, first_name: 'Иван', is_bot: false },
      text: '/search погода',
    });
    assert.match(h3.apiCalls.at(-1).params.text, /Не удалось выполнить поиск через Gemini/);
  });
});
