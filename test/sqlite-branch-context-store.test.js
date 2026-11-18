import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBotProcessor } from '../tgcloud/lib/bot-processor.js';
import { BranchRole } from '../tgcloud/lib/branch-context-store.js';
import { createConfig } from '../tgcloud/lib/config.js';
import { createSqliteBranchContextStore } from '../tgcloud/lib/sqlite-branch-context-store.js';

const mockTable = {
  nodeKey: 'nodeKey',
  createdAt: 'createdAt',
};

const eq = (col, value) => ({ op: 'eq', col, value });
const lt = (col, value) => ({ op: 'lt', col, value });

function createMockSqliteDb({ failWith = null } = {}) {
  const rows = new Map();

  function maybeFail() {
    if (failWith) {
      throw failWith;
    }
  }

  return {
    rows,
    select() {
      return {
        from() {
          return {
            where(cond) {
              return {
                async get() {
                  maybeFail();
                  if (cond.op === 'eq' && cond.col === 'nodeKey') {
                    return rows.get(cond.value) ?? null;
                  }
                  return null;
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(entry) {
          return {
            onConflictDoUpdate({ set }) {
              return {
                async run() {
                  maybeFail();
                  const existing = rows.get(entry.nodeKey);
                  rows.set(entry.nodeKey, existing ? { ...existing, ...set } : { ...entry });
                  return { rowsAffected: 1 };
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where(cond) {
          return {
            async run() {
              maybeFail();
              let deleted = 0;
              if (cond.op === 'lt' && cond.col === 'createdAt') {
                for (const [k, row] of rows) {
                  if (row.createdAt < cond.value) {
                    rows.delete(k);
                    deleted += 1;
                  }
                }
              }
              return { rowsAffected: deleted };
            },
          };
        },
      };
    },
  };
}

describe('sqlite-branch-context-store', () => {
  it('persists reply-branch memory across isolate cold starts', async () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const sharedDb = createMockSqliteDb();
    const config = createConfig({
      systemPrompt: 'Ты Подсолнух.',
      branchMaxDepth: 8,
      branchMaxContextChars: 6000,
    });

    // Isolate #1 records forwarded message, user question, and bot answer
    const isolate1Store = createSqliteBranchContextStore({
      db: sharedDb,
      table: mockTable,
      eq,
      lt,
      config,
      nowFn: () => now,
    });

    await isolate1Store.recordNode({
      chatId: -1001,
      messageId: 10,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'Алексей',
      forwardedFrom: 'TechNews',
      text: 'Релиз Telegram Serverless состоялся.',
      createdAt: now,
    });
    await isolate1Store.recordNode({
      chatId: -1001,
      messageId: 11,
      parentMessageId: 10,
      role: BranchRole.USER,
      authorLabel: 'Мария',
      text: 'А база данных там есть?',
      createdAt: now + 2_000,
    });
    await isolate1Store.recordNode({
      chatId: -1001,
      messageId: 12,
      parentMessageId: 11,
      role: BranchRole.ASSISTANT,
      authorLabel: 'answering_bot',
      text: 'Да, встроенная SQLite через sdk/db.',
      createdAt: now + 4_000,
    });

    // Cold start: brand-new isolate instance with empty RAM, same SQLite DB
    const isolate2Store = createSqliteBranchContextStore({
      db: sharedDb,
      table: mockTable,
      eq,
      lt,
      config,
      nowFn: () => now + 60_000,
    });

    assert.equal(await isolate2Store.contains(-1001, 12), true);

    await isolate2Store.recordNode({
      chatId: -1001,
      messageId: 13,
      parentMessageId: 12,
      role: BranchRole.USER,
      authorLabel: 'Петр',
      text: 'А foreign keys поддерживаются?',
      createdAt: now + 60_000,
    });

    const prompt = await isolate2Store.buildPromptMessages(-1001, 13);
    assert.equal(prompt.length, 5);
    assert.equal(prompt[0].role, 'system');
    assert.match(prompt[1].content, /\[Переслано от TechNews\]/);
    assert.match(prompt[2].content, /Мария: А база данных там есть\?/);
    assert.deepEqual(prompt[3], {
      role: 'assistant',
      content: 'Да, встроенная SQLite через sdk/db.',
    });
    assert.match(prompt[4].content, /Петр: А foreign keys поддерживаются\?/);
  });

  it('enforces max depth and character budget to keep token usage low', async () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const sharedDb = createMockSqliteDb();
    const config = createConfig({
      systemPrompt: 'System',
      branchMaxDepth: 8,
      branchMaxContextChars: 120,
    });

    const store = createSqliteBranchContextStore({
      db: sharedDb,
      table: mockTable,
      eq,
      lt,
      config,
      nowFn: () => now,
    });

    for (let i = 1; i <= 5; i += 1) {
      await store.recordNode({
        chatId: -1002,
        messageId: i,
        parentMessageId: i === 1 ? null : i - 1,
        role: i % 2 === 0 ? BranchRole.ASSISTANT : BranchRole.USER,
        authorLabel: 'User',
        text: `m${i}-` + 'x'.repeat(45), // ~50 chars each
        createdAt: now + i * 1000,
      });
    }

    const prompt = await store.buildPromptMessages(-1002, 5);
    // System + at most 2 newest messages (~100-110 chars <= 120 budget)
    assert.equal(prompt.length, 3);
    assert.match(prompt[1].content, /m4-/);
    assert.match(prompt[2].content, /m5-/);
  });

  it('prunes expired rows on write and skips expired rows on read', async () => {
    let currentTime = Date.parse('2026-11-18T12:00:00Z');
    const sharedDb = createMockSqliteDb();
    const config = createConfig({
      branchCacheTtlMs: 10 * 60 * 1000,
    });

    const store = createSqliteBranchContextStore({
      db: sharedDb,
      table: mockTable,
      eq,
      lt,
      config,
      nowFn: () => currentTime,
    });

    await store.recordNode({
      chatId: -1003,
      messageId: 1,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'U1',
      text: 'old message',
      createdAt: currentTime,
    });

    currentTime += 11 * 60 * 1000;
    assert.equal(await store.contains(-1003, 1), false);

    await store.recordNode({
      chatId: -1003,
      messageId: 2,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'U2',
      text: 'fresh message',
      createdAt: currentTime,
    });

    assert.equal(sharedDb.rows.has('-1003:1'), false);
    assert.equal(sharedDb.rows.has('-1003:2'), true);
  });

  it('gracefully falls back to in-memory cache if table is not migrated yet', async () => {
    const warnings = [];
    const failingDb = createMockSqliteDb({ failWith: new Error('no such table: branch_nodes') });
    const config = createConfig({ systemPrompt: 'System' });
    const store = createSqliteBranchContextStore({
      db: failingDb,
      table: mockTable,
      eq,
      lt,
      config,
      logger: {
        warn(msg) {
          warnings.push(msg);
        },
      },
    });

    await store.recordNode({
      chatId: -1004,
      messageId: 1,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'Анна',
      text: 'Привет',
    });
    await store.recordNode({
      chatId: -1004,
      messageId: 2,
      parentMessageId: 1,
      role: BranchRole.ASSISTANT,
      authorLabel: 'bot',
      text: 'Привет!',
    });

    assert.equal(await store.contains(-1004, 2), true);
    const prompt = await store.buildPromptMessages(-1004, 2);
    assert.equal(prompt.length, 3);
    assert.match(prompt[1].content, /Анна: Привет/);
    assert.equal(prompt[2].content, 'Привет!');
    // Warns only once per isolate to avoid log spam
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /npx tgcloud migrate/);
  });

  it('integrates end-to-end with bot-processor across a cold start', async () => {
    const sharedDb = createMockSqliteDb();
    const config = createConfig({
      systemPrompt: 'Кратко.',
      botId: 999,
      botUsername: 'answering_bot',
    });
    const llmPrompts = [];
    let sentId = 200;

    const api = {
      async sendChatAction() {
        return true;
      },
      async sendMessage(params) {
        return {
          message_id: sentId++,
          chat: { id: params.chat_id, type: 'supergroup' },
          from: { id: 999, is_bot: true, first_name: 'Bot' },
          text: params.text,
        };
      },
    };

    const answers = ['Первый ответ.', 'Второй ответ с контекстом.'];
    let idx = 0;
    const llmService = {
      async generateAnswer(messages) {
        llmPrompts.push(messages);
        return answers[idx++];
      },
    };

    const group = { id: -500, type: 'supergroup' };

    // Turn 1 in Isolate #1
    const processor1 = createBotProcessor({
      api,
      config,
      contextStore: createSqliteBranchContextStore({ db: sharedDb, table: mockTable, eq, lt, config }),
      llmService,
      logger: { warn() {}, error() {}, debug() {} },
    });

    await processor1.processMessage({
      message_id: 101,
      chat: group,
      from: { id: 1, first_name: 'Олег', is_bot: false },
      reply_to_message: {
        message_id: 100,
        chat: group,
        text: 'Исходный пост про Node.js 24',
      },
      text: '@answering_bot что нового?',
    });

    // Turn 2 in brand-new Isolate #2 (cold start) replying to bot message 200
    const processor2 = createBotProcessor({
      api,
      config,
      contextStore: createSqliteBranchContextStore({ db: sharedDb, table: mockTable, eq, lt, config }),
      llmService,
      logger: { warn() {}, error() {}, debug() {} },
    });

    await processor2.processMessage({
      message_id: 102,
      chat: group,
      from: { id: 2, first_name: 'Лена', is_bot: false },
      reply_to_message: {
        message_id: 200,
        chat: group,
        from: { id: 999, is_bot: true, first_name: 'Bot' },
        text: 'Первый ответ.',
      },
      text: 'А когда релиз LTS?',
    });

    assert.equal(llmPrompts.length, 2);
    assert.equal(llmPrompts[1].length, 5); // system + post + Q1 + A1 + Q2
    assert.match(llmPrompts[1][1].content, /Исходный пост про Node\.js 24/);
    assert.equal(llmPrompts[1][3].content, 'Первый ответ.');
    assert.match(llmPrompts[1][4].content, /А когда релиз LTS\?/);
  });
});
