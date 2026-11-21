import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BranchRole } from '../tgcloud/lib/branch-context-store.js';
import { createSqliteBusinessStore } from '../tgcloud/lib/business-store.js';
import { createConfig } from '../tgcloud/lib/config.js';

const tables = {
  connections: {
    name: 'business_connections',
    id: 'id',
    userId: 'userId',
    updatedAt: 'updatedAt',
  },
  messages: {
    name: 'business_messages',
    entryKey: 'entryKey',
    businessConnectionId: 'businessConnectionId',
    chatId: 'chatId',
    messageId: 'messageId',
    createdAt: 'createdAt',
  },
  chatStates: {
    name: 'business_chat_states',
    stateKey: 'stateKey',
    userId: 'userId',
    paused: 'paused',
  },
};

const eq = (col, value) => ({ op: 'eq', col, value });
const lt = (col, value) => ({ op: 'lt', col, value });
const and = (...conds) => ({ op: 'and', conds });
const desc = (col) => ({ dir: 'desc', col });
const ops = { eq, and, lt, desc };

function matchesCond(row, cond) {
  if (!cond) return true;
  if (cond.op === 'eq') return row[cond.col] === cond.value;
  if (cond.op === 'lt') return row[cond.col] < cond.value;
  if (cond.op === 'and') return cond.conds.every((c) => matchesCond(row, c));
  return false;
}

function createMockBusinessDb({ failWith = null } = {}) {
  const stores = {
    business_connections: new Map(),
    business_messages: new Map(),
    business_chat_states: new Map(),
  };

  function keyField(table) {
    if (table.name === 'business_connections') return 'id';
    if (table.name === 'business_messages') return 'entryKey';
    return 'stateKey';
  }

  function maybeFail() {
    if (failWith) throw failWith;
  }

  return {
    stores,
    select() {
      return {
        from(table) {
          let whereCond = null;
          let orderCols = [];
          let limitCount = null;

          const query = {
            where(cond) {
              whereCond = cond;
              return query;
            },
            orderBy(...orders) {
              orderCols = orders;
              return query;
            },
            limit(n) {
              limitCount = n;
              return query;
            },
            async get() {
              maybeFail();
              for (const row of stores[table.name].values()) {
                if (matchesCond(row, whereCond)) {
                  return { ...row };
                }
              }
              return null;
            },
            async all() {
              maybeFail();
              let rows = [...stores[table.name].values()]
                .filter((row) => matchesCond(row, whereCond))
                .map((row) => ({ ...row }));
              if (orderCols.length > 0) {
                rows.sort((a, b) => {
                  for (const o of orderCols) {
                    const diff = (b[o.col] ?? 0) - (a[o.col] ?? 0);
                    if (diff !== 0) return diff;
                  }
                  return 0;
                });
              }
              if (limitCount != null) {
                rows = rows.slice(0, limitCount);
              }
              return rows;
            },
          };
          return query;
        },
      };
    },
    insert(table) {
      return {
        values(entry) {
          return {
            onConflictDoUpdate({ set }) {
              return {
                async run() {
                  maybeFail();
                  const pk = entry[keyField(table)];
                  const existing = stores[table.name].get(pk);
                  stores[table.name].set(pk, existing ? { ...existing, ...set } : { ...entry });
                  return { rowsAffected: 1 };
                },
              };
            },
          };
        },
      };
    },
    update(table) {
      return {
        set(patch) {
          return {
            where(cond) {
              return {
                async run() {
                  maybeFail();
                  let updated = 0;
                  for (const [k, row] of stores[table.name]) {
                    if (matchesCond(row, cond)) {
                      stores[table.name].set(k, { ...row, ...patch });
                      updated += 1;
                    }
                  }
                  return { rowsAffected: updated };
                },
              };
            },
          };
        },
      };
    },
    delete(table) {
      return {
        where(cond) {
          return {
            async run() {
              maybeFail();
              let deleted = 0;
              for (const [k, row] of stores[table.name]) {
                if (matchesCond(row, cond)) {
                  stores[table.name].delete(k);
                  deleted += 1;
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

describe('business-store', () => {
  it('persists connections, isolated chat history, edits, deletions, and pause state across cold starts', async () => {
    let now = Date.parse('2026-11-20T12:00:00Z');
    const sharedDb = createMockBusinessDb();
    const config = createConfig({
      secretarySystemPrompt: 'Промпт секретаря.',
      secretaryMaxHistory: 8,
      secretaryMaxContextChars: 6000,
    });

    const isolate1 = createSqliteBusinessStore({
      db: sharedDb,
      tables,
      ops,
      config,
      nowFn: () => now,
    });

    const saved = await isolate1.upsertConnection({
      id: 'bc_1',
      user: { id: 42, first_name: 'Алексей' },
      user_chat_id: 42,
      date: Math.floor(now / 1000),
      is_enabled: true,
      rights: { can_reply: true, can_read_messages: true },
    });
    assert.equal(saved.persisted, true);
    assert.equal(saved.connection.canReply, true);
    assert.equal(saved.connection.canReadMessages, true);

    await isolate1.recordMessage({
      businessConnectionId: 'bc_1',
      chatId: 500,
      messageId: 1,
      role: BranchRole.USER,
      authorLabel: 'Клиент',
      text: 'Здравствуйте, сколько стоит?',
      createdAt: now,
    });
    await isolate1.recordMessage({
      businessConnectionId: 'bc_1',
      chatId: 500,
      messageId: 2,
      role: BranchRole.ASSISTANT,
      authorLabel: 'Алексей',
      text: 'Уточните, пожалуйста, услугу.',
      createdAt: now + 1000,
    });
    // Different business connection with same chatId must stay isolated
    await isolate1.recordMessage({
      businessConnectionId: 'bc_other',
      chatId: 500,
      messageId: 1,
      role: BranchRole.USER,
      authorLabel: 'Другой',
      text: 'Чужое сообщение',
      createdAt: now + 500,
    });

    await isolate1.setChatPaused(42, 500, true);

    // Cold start: brand-new store instance
    const isolate2 = createSqliteBusinessStore({
      db: sharedDb,
      tables,
      ops,
      config,
      nowFn: () => now + 5000,
    });

    const conn = await isolate2.getConnection('bc_1');
    assert.equal(conn?.userId, 42);
    assert.equal(conn?.canReply, true);
    assert.equal(await isolate2.isChatPaused(42, 500), true);
    assert.equal(await isolate2.countPausedChats(42), 1);

    // Edit message 1 and verify prompt reflects edited text
    assert.equal(await isolate2.updateMessageText('bc_1', 500, 1, 'Здравствуйте, сколько стоит консультация?'), true);
    const prompt1 = await isolate2.buildPromptMessages('bc_1', 500);
    assert.equal(prompt1.length, 3);
    assert.equal(prompt1[0].content, 'Промпт секретаря.');
    assert.match(prompt1[1].content, /сколько стоит консультация\?/);
    assert.equal(prompt1[2].content, 'Уточните, пожалуйста, услугу.');

    // Delete message 1 and verify it disappears from context
    await isolate2.deleteMessages('bc_1', 500, [1]);
    const prompt2 = await isolate2.buildPromptMessages('bc_1', 500);
    assert.equal(prompt2.length, 2);
    assert.equal(prompt2[1].content, 'Уточните, пожалуйста, услугу.');

    // Clear chat history
    await isolate2.clearChatHistory('bc_1', 500);
    const prompt3 = await isolate2.buildPromptMessages('bc_1', 500);
    assert.equal(prompt3.length, 1); // only system prompt
  });

  it('gracefully falls back to in-memory mirror when SQLite tables are not migrated yet', async () => {
    const warnings = [];
    const failingDb = createMockBusinessDb({ failWith: new Error('no such table: business_connections') });
    const config = createConfig({ secretarySystemPrompt: 'Секретарь.' });

    const store = createSqliteBusinessStore({
      db: failingDb,
      tables,
      ops,
      config,
      logger: {
        warn(msg) {
          warnings.push(msg);
        },
      },
    });

    const res = await store.upsertConnection({
      id: 'bc_fallback',
      user: { id: 7, first_name: 'Иван' },
      user_chat_id: 7,
      is_enabled: true,
      rights: { can_reply: true },
    });
    assert.equal(res.persisted, false);
    assert.equal((await store.getConnection('bc_fallback'))?.canReply, true);

    await store.recordMessage({
      businessConnectionId: 'bc_fallback',
      chatId: 100,
      messageId: 10,
      role: BranchRole.USER,
      authorLabel: 'Гость',
      text: 'Привет',
    });
    const prompt = await store.buildPromptMessages('bc_fallback', 100);
    assert.equal(prompt.length, 2);
    assert.match(prompt[1].content, /Гость: Привет/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /npx tgcloud migrate/);
  });
});
