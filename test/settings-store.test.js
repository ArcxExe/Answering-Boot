import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInMemorySettingsStore,
  createSqliteSettingsStore,
  SYSTEM_PROMPT_KEY,
} from '../tgcloud/lib/settings-store.js';

const mockTable = {
  key: 'key',
};

const eq = (col, value) => ({ op: 'eq', col, value });

function createMockSettingsDb({ failWith = null } = {}) {
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
                  if (cond.op === 'eq' && cond.col === 'key') {
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
                  const existing = rows.get(entry.key);
                  rows.set(entry.key, existing ? { ...existing, ...set } : { ...entry });
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
              if (cond.op === 'eq' && cond.col === 'key') {
                rows.delete(cond.value);
              }
              return { rowsAffected: 1 };
            },
          };
        },
      };
    },
  };
}

describe('settings-store', () => {
  it('persists, updates, and resets custom system prompt across cold starts in SQLite', async () => {
    let now = 1_700_000_000_000;
    const sharedDb = createMockSettingsDb();

    const isolate1 = createSqliteSettingsStore({
      db: sharedDb,
      table: mockTable,
      eq,
      nowFn: () => now,
    });

    assert.equal(await isolate1.getSystemPrompt(), null);

    const saveRes = await isolate1.setSystemPrompt('  Отвечай только фактами.  ');
    assert.deepEqual(saveRes, { persisted: true });
    assert.equal(sharedDb.rows.get(SYSTEM_PROMPT_KEY)?.value, 'Отвечай только фактами.');

    // Cold start: brand-new store instance pointing to the same SQLite DB
    now += 60_000;
    const isolate2 = createSqliteSettingsStore({
      db: sharedDb,
      table: mockTable,
      eq,
      nowFn: () => now,
    });

    assert.equal(await isolate2.getSystemPrompt(), 'Отвечай только фактами.');

    await isolate2.setSystemPrompt('Новый промпт v2');
    assert.equal(await isolate2.getSystemPrompt(), 'Новый промпт v2');

    const resetRes = await isolate2.resetSystemPrompt();
    assert.deepEqual(resetRes, { persisted: true });
    assert.equal(await isolate2.getSystemPrompt(), null);
  });

  it('gracefully falls back to in-memory storage if bot_settings table is not migrated yet', async () => {
    const warnings = [];
    const failingDb = createMockSettingsDb({ failWith: new Error('no such table: bot_settings') });

    const store = createSqliteSettingsStore({
      db: failingDb,
      table: mockTable,
      eq,
      logger: {
        warn(msg) {
          warnings.push(msg);
        },
      },
    });

    assert.equal(await store.getSystemPrompt(), null);

    const setRes = await store.setSystemPrompt('Временный промпт');
    assert.deepEqual(setRes, { persisted: false });
    assert.equal(await store.getSystemPrompt(), 'Временный промпт');

    const resetRes = await store.resetSystemPrompt();
    assert.deepEqual(resetRes, { persisted: false });
    assert.equal(await store.getSystemPrompt(), null);

    // Warns only once per isolate to avoid log spam
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /npx tgcloud migrate/);
  });

  it('supports createInMemorySettingsStore and rejects blank prompts', async () => {
    const store = createInMemorySettingsStore();
    assert.equal(await store.getSystemPrompt(), null);
    await assert.rejects(() => store.setSystemPrompt('   '), RangeError);

    await store.setSystemPrompt('Промпт в памяти');
    assert.equal(await store.getSystemPrompt(), 'Промпт в памяти');

    await store.resetSystemPrompt();
    assert.equal(await store.getSystemPrompt(), null);
  });
});
