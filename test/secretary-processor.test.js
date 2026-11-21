import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBotProcessor } from '../tgcloud/lib/bot-processor.js';
import { BranchContextStore } from '../tgcloud/lib/branch-context-store.js';
import { createInMemoryBusinessStore } from '../tgcloud/lib/business-store.js';
import { createConfig } from '../tgcloud/lib/config.js';
import { createSecretaryProcessor } from '../tgcloud/lib/secretary-processor.js';
import { createInMemorySettingsStore } from '../tgcloud/lib/settings-store.js';

const BOT_ID = 999;
const BOT_USERNAME = 'answering_bot';
const silentLogger = { warn() {}, error() {}, debug() {} };

function createSecretaryHarness({
  ownerId = 42,
  secretaryAllowAll = false,
  secretaryMarkAsRead = true,
  llmAnswers = ['Добрый день! Передам ваш вопрос владельцу.'],
  llmError = null,
  remoteConnections = {},
} = {}) {
  const config = createConfig({
    ownerId,
    secretaryAllowAll,
    secretaryMarkAsRead,
    secretarySystemPrompt: 'Вежливый секретарь.',
    botId: BOT_ID,
    botUsername: BOT_USERNAME,
  });

  const businessStore = createInMemoryBusinessStore(config);
  const settingsStore = createInMemorySettingsStore();
  const contextStore = new BranchContextStore(config);

  const apiCalls = [];
  const llmPrompts = [];
  let nextSentId = 900;
  let answerIndex = 0;

  const api = {
    async sendChatAction(params) {
      apiCalls.push({ method: 'sendChatAction', params });
      return true;
    },
    async sendMessage(params) {
      apiCalls.push({ method: 'sendMessage', params });
      return {
        message_id: nextSentId++,
        chat: { id: params.chat_id, type: 'private' },
        text: params.text,
      };
    },
    async readBusinessMessage(params) {
      apiCalls.push({ method: 'readBusinessMessage', params });
      return true;
    },
    async getBusinessConnection({ business_connection_id }) {
      apiCalls.push({ method: 'getBusinessConnection', params: { business_connection_id } });
      return remoteConnections[business_connection_id] ?? null;
    },
    async answerCallbackQuery(params) {
      apiCalls.push({ method: 'answerCallbackQuery', params });
      return true;
    },
    async editMessageText(params) {
      apiCalls.push({ method: 'editMessageText', params });
      return true;
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

  const secretaryProcessor = createSecretaryProcessor({
    api,
    config,
    businessStore,
    settingsStore,
    llmService,
    logger: silentLogger,
  });

  const botProcessor = createBotProcessor({
    api,
    config,
    contextStore,
    settingsStore,
    llmService,
    secretaryProcessor,
    logger: silentLogger,
  });

  return {
    secretaryProcessor,
    botProcessor,
    businessStore,
    settingsStore,
    apiCalls,
    llmPrompts,
  };
}

describe('secretary-processor', () => {
  it('stores business_connection, replies with business_connection_id, and marks message as read', async () => {
    const { secretaryProcessor, apiCalls, llmPrompts } = createSecretaryHarness({
      llmAnswers: ['Здравствуйте! Алексей сейчас занят, но скоро ответит.'],
    });

    await secretaryProcessor.handleBusinessConnection({
      id: 'conn_1',
      user: { id: 42, first_name: 'Алексей' },
      user_chat_id: 42,
      date: 1732100000,
      is_enabled: true,
      rights: { can_reply: true, can_read_messages: true },
    });

    const connectNotice = apiCalls.find(
      (c) => c.method === 'sendMessage' && c.params.chat_id === 42
    );
    assert.ok(connectNotice);
    assert.match(connectNotice.params.text, /Режим секретаря подключён/);

    await secretaryProcessor.handleBusinessMessage({
      message_id: 101,
      business_connection_id: 'conn_1',
      chat: { id: 700, type: 'private' },
      from: { id: 700, first_name: 'Мария', is_bot: false },
      text: 'Привет! Ты сегодня на встрече будешь?',
    });

    assert.equal(llmPrompts.length, 1);
    assert.equal(llmPrompts[0][0].content, 'Вежливый секретарь.');
    assert.match(llmPrompts[0][1].content, /Мария: Привет! Ты сегодня на встрече будешь\?/);

    const typing = apiCalls.find((c) => c.method === 'sendChatAction');
    assert.deepEqual(typing?.params, {
      business_connection_id: 'conn_1',
      chat_id: 700,
      action: 'typing',
    });

    const bizReply = apiCalls.find(
      (c) => c.method === 'sendMessage' && c.params.business_connection_id === 'conn_1'
    );
    assert.ok(bizReply);
    assert.equal(bizReply.params.chat_id, 700);
    assert.equal(bizReply.params.text, 'Здравствуйте! Алексей сейчас занят, но скоро ответит.');

    const readCall = apiCalls.find((c) => c.method === 'readBusinessMessage');
    assert.deepEqual(readCall?.params, {
      business_connection_id: 'conn_1',
      chat_id: 700,
      message_id: 101,
    });
  });

  it('prevents loops, skips offline/bot messages, and records owner manual replies without auto-replying', async () => {
    const { secretaryProcessor, apiCalls, llmPrompts } = createSecretaryHarness({
      llmAnswers: ['Хорошо, передам!'],
    });

    await secretaryProcessor.handleBusinessConnection({
      id: 'conn_2',
      user: { id: 42, first_name: 'Алексей' },
      user_chat_id: 42,
      is_enabled: true,
      rights: { can_reply: true },
    });
    apiCalls.length = 0;

    // Bot's own outgoing echo (sender_business_bot) must be ignored
    await secretaryProcessor.handleBusinessMessage({
      message_id: 1,
      business_connection_id: 'conn_2',
      chat: { id: 701, type: 'private' },
      from: { id: 42, first_name: 'Алексей', is_bot: false },
      sender_business_bot: { id: BOT_ID, is_bot: true, first_name: 'Bot' },
      text: 'Мой предыдущий ответ',
    });

    // Offline away/greeting message must be ignored
    await secretaryProcessor.handleBusinessMessage({
      message_id: 2,
      business_connection_id: 'conn_2',
      chat: { id: 701, type: 'private' },
      from: { id: 42, first_name: 'Алексей', is_bot: false },
      is_from_offline: true,
      text: 'Я сейчас не на месте',
    });

    // Owner manually writes in the chat -> saved to history as assistant, NO bot reply
    await secretaryProcessor.handleBusinessMessage({
      message_id: 3,
      business_connection_id: 'conn_2',
      chat: { id: 701, type: 'private' },
      from: { id: 42, first_name: 'Алексей', is_bot: false },
      text: 'Буду в офисе к 15:00.',
    });

    assert.equal(llmPrompts.length, 0);
    assert.equal(apiCalls.length, 0);

    // Contact follows up -> secretary sees owner's manual reply in context!
    await secretaryProcessor.handleBusinessMessage({
      message_id: 4,
      business_connection_id: 'conn_2',
      chat: { id: 701, type: 'private' },
      from: { id: 701, first_name: 'Дмитрий', is_bot: false },
      text: 'Отлично, тогда занесу документы в 15:30.',
    });

    assert.equal(llmPrompts.length, 1);
    assert.equal(llmPrompts[0].length, 3);
    assert.deepEqual(llmPrompts[0][1], { role: 'assistant', content: 'Буду в офисе к 15:00.' });
    assert.match(llmPrompts[0][2].content, /Дмитрий: Отлично, тогда занесу документы/);
  });

  it('fetches unknown connection via getBusinessConnection and respects can_reply=false and LLM silence', async () => {
    // 1. Missing connection fetched via API with can_reply: false
    const h1 = createSecretaryHarness({
      remoteConnections: {
        conn_remote: {
          id: 'conn_remote',
          user: { id: 42, first_name: 'Алексей' },
          user_chat_id: 42,
          is_enabled: true,
          rights: { can_reply: false },
        },
      },
    });

    await h1.secretaryProcessor.handleBusinessMessage({
      message_id: 10,
      business_connection_id: 'conn_remote',
      chat: { id: 702, type: 'private' },
      from: { id: 702, first_name: 'Ольга', is_bot: false },
      text: 'Привет',
    });

    assert.equal(
      h1.apiCalls.some((c) => c.method === 'getBusinessConnection'),
      true
    );
    assert.equal(h1.llmPrompts.length, 0);
    assert.equal(
      h1.apiCalls.some((c) => c.method === 'sendMessage'),
      false
    );

    // 2. LLM error in Secretary Mode must NOT send error text to the owner's personal contact
    const h2 = createSecretaryHarness({ llmError: new Error('Rate limit') });
    await h2.secretaryProcessor.handleBusinessConnection({
      id: 'conn_err',
      user: { id: 42, first_name: 'Алексей' },
      user_chat_id: 42,
      is_enabled: true,
      rights: { can_reply: true, can_read_messages: true },
    });
    h2.apiCalls.length = 0;

    await h2.secretaryProcessor.handleBusinessMessage({
      message_id: 11,
      business_connection_id: 'conn_err',
      chat: { id: 703, type: 'private' },
      from: { id: 703, first_name: 'Иван', is_bot: false },
      text: 'Срочный вопрос',
    });

    assert.equal(
      h2.apiCalls.some((c) => c.method === 'sendMessage'),
      false
    );
    assert.equal(
      h2.apiCalls.some((c) => c.method === 'readBusinessMessage'),
      false
    );
  });

  it('protects quota when OWNER_ID is configured unless SECRETARY_ALLOW_ALL=true', async () => {
    const h = createSecretaryHarness({ ownerId: 42, secretaryAllowAll: false });

    await h.secretaryProcessor.handleBusinessConnection({
      id: 'conn_stranger',
      user: { id: 9999, first_name: 'Чужой' },
      user_chat_id: 9999,
      is_enabled: true,
      rights: { can_reply: true },
    });

    await h.secretaryProcessor.handleBusinessMessage({
      message_id: 1,
      business_connection_id: 'conn_stranger',
      chat: { id: 888, type: 'private' },
      from: { id: 888, first_name: 'Клиент', is_bot: false },
      text: 'Привет',
    });

    assert.equal(h.llmPrompts.length, 0);
    assert.equal(
      h.apiCalls.some((c) => c.params?.business_connection_id === 'conn_stranger'),
      false
    );
  });

  it('supports Manage Bot deep link (/start bizChat<id>), pause/resume/clear buttons, edits, deletions, and /set_secretary_prompt', async () => {
    const { secretaryProcessor, botProcessor, apiCalls, llmPrompts } = createSecretaryHarness({
      ownerId: 42,
      llmAnswers: ['Ответ с новым промптом.'],
    });
    const dmOwner = { id: 42, type: 'private' };
    const ownerUser = { id: 42, first_name: 'Алексей', is_bot: false };

    await secretaryProcessor.handleBusinessConnection({
      id: 'conn_manage',
      user: ownerUser,
      user_chat_id: 42,
      is_enabled: true,
      rights: { can_reply: true, can_read_messages: false },
    });

    // 1. Update secretary prompt via DM command
    await botProcessor.processMessage({
      message_id: 1,
      chat: dmOwner,
      from: ownerUser,
      text: '/set_secretary_prompt Отвечай в деловом стиле от лица студии.',
    });
    assert.match(apiCalls.at(-1).params.text, /обновлён/);

    // 2. Owner taps "Manage Bot" in chat 555 -> Telegram sends /start bizChat555
    await botProcessor.processMessage({
      message_id: 2,
      chat: dmOwner,
      from: ownerUser,
      text: '/start bizChat555',
    });
    const managePanel = apiCalls.at(-1);
    assert.match(managePanel.params.text, /Управление чатом 555/);
    assert.equal(
      managePanel.params.reply_markup.inline_keyboard[0][0].callback_data,
      'sec:pause:555'
    );

    // 3. Owner clicks Pause button
    await secretaryProcessor.handleCallbackQuery({
      id: 'cb_1',
      from: ownerUser,
      data: 'sec:pause:555',
      message: { message_id: 901, chat: dmOwner },
    });

    // Incoming message while paused is recorded but NOT answered
    await secretaryProcessor.handleBusinessMessage({
      message_id: 50,
      business_connection_id: 'conn_manage',
      chat: { id: 555, type: 'private' },
      from: { id: 555, first_name: 'Клиент', is_bot: false },
      text: 'Первое сообщение (опечатка)',
    });
    assert.equal(llmPrompts.length, 0);

    // Contact edits message 50 and sends & deletes message 51
    await secretaryProcessor.handleEditedBusinessMessage({
      message_id: 50,
      business_connection_id: 'conn_manage',
      chat: { id: 555, type: 'private' },
      text: 'Первое сообщение (исправлено)',
    });
    await secretaryProcessor.handleBusinessMessage({
      message_id: 51,
      business_connection_id: 'conn_manage',
      chat: { id: 555, type: 'private' },
      from: { id: 555, first_name: 'Клиент', is_bot: false },
      text: 'Удалённое сообщение',
    });
    await secretaryProcessor.handleDeletedBusinessMessages({
      business_connection_id: 'conn_manage',
      chat: { id: 555, type: 'private' },
      message_ids: [51],
    });

    // 4. Owner clicks Resume button
    await secretaryProcessor.handleCallbackQuery({
      id: 'cb_2',
      from: ownerUser,
      data: 'sec:resume:555',
      message: { message_id: 901, chat: dmOwner },
    });

    // Next message triggers secretary with custom prompt + edited message 50 (without deleted 51)
    await secretaryProcessor.handleBusinessMessage({
      message_id: 52,
      business_connection_id: 'conn_manage',
      chat: { id: 555, type: 'private' },
      from: { id: 555, first_name: 'Клиент', is_bot: false },
      text: 'Когда созвон?',
    });

    assert.equal(llmPrompts.length, 1);
    assert.equal(llmPrompts[0][0].content, 'Отвечай в деловом стиле от лица студии.');
    assert.equal(llmPrompts[0].length, 3); // system + edited #50 + #52
    assert.match(llmPrompts[0][1].content, /исправлено/);
    assert.match(llmPrompts[0][2].content, /Когда созвон\?/);

    // 5. /secretary status command reports active connection
    await botProcessor.processMessage({
      message_id: 3,
      chat: dmOwner,
      from: ownerUser,
      text: '/secretary',
    });
    assert.match(apiCalls.at(-1).params.text, /Статус режима секретаря: ✅ активен/);
  });
});
