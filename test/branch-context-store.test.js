import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BranchContextStore, BranchRole } from '../tgcloud/lib/branch-context-store.js';
import { createConfig } from '../tgcloud/lib/config.js';

function makeConfig({ maxDepth = 20, maxSize = 100, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  return createConfig({
    systemPrompt: 'Будь кратким и информативным.',
    branchMaxDepth: maxDepth,
    branchCacheMaxSize: maxSize,
    branchCacheTtlMs: ttlMs,
  });
}

describe('BranchContextStore', () => {
  it('builds multi-step reply chain from root to leaf', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const store = new BranchContextStore(makeConfig(), () => now);
    const chatId = -1001;

    store.recordNode({
      chatId,
      messageId: 10,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'Иван',
      forwardedFrom: 'Канал Codex',
      text: 'Сегодня вышло обновление Codex',
      createdAt: now,
    });
    store.recordNode({
      chatId,
      messageId: 11,
      parentMessageId: 10,
      role: BranchRole.USER,
      authorLabel: 'Мария',
      forwardedFrom: null,
      text: 'Когда день рождения у codex?',
      createdAt: now + 5_000,
    });
    store.recordNode({
      chatId,
      messageId: 12,
      parentMessageId: 11,
      role: BranchRole.ASSISTANT,
      authorLabel: 'bot',
      forwardedFrom: null,
      text: 'Codex впервые представили 10 августа 2021 года.',
      createdAt: now + 8_000,
    });
    store.recordNode({
      chatId,
      messageId: 13,
      parentMessageId: 12,
      role: BranchRole.USER,
      authorLabel: 'Петр',
      forwardedFrom: null,
      text: 'А когда вышла новая версия?',
      createdAt: now + 12_000,
    });

    const prompt = store.buildPromptMessages(chatId, 13);

    assert.equal(prompt.length, 5);
    assert.deepEqual(prompt[0], { role: 'system', content: 'Будь кратким и информативным.' });
    assert.equal(prompt[1].role, 'user');
    assert.match(prompt[1].content, /\[Переслано от Канал Codex\]/);
    assert.match(prompt[1].content, /Сегодня вышло обновление Codex/);
    assert.equal(prompt[2].role, 'user');
    assert.match(prompt[2].content, /Мария/);
    assert.match(prompt[2].content, /Когда день рождения у codex\?/);
    assert.deepEqual(prompt[3], {
      role: 'assistant',
      content: 'Codex впервые представили 10 августа 2021 года.',
    });
    assert.equal(prompt[4].role, 'user');
    assert.match(prompt[4].content, /Петр/);
    assert.match(prompt[4].content, /А когда вышла новая версия\?/);
  });

  it('respects max depth limit and avoids cycles', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const store = new BranchContextStore(makeConfig({ maxDepth: 3 }), () => now);
    const chatId = -1002;

    for (let i = 1; i <= 10; i += 1) {
      store.recordNode({
        chatId,
        messageId: i,
        parentMessageId: i === 1 ? 10 : i - 1, // intentional cycle on node 1 -> 10
        role: BranchRole.USER,
        authorLabel: 'User',
        forwardedFrom: null,
        text: `msg-${i}`,
        createdAt: now + i * 1000,
      });
    }

    const prompt = store.buildPromptMessages(chatId, 10);

    assert.equal(prompt.length, 4); // system + 3 deepest messages
    assert.match(prompt[1].content, /msg-8/);
    assert.match(prompt[2].content, /msg-9/);
    assert.match(prompt[3].content, /msg-10/);
  });

  it('evicts overflow entries and expired entries by TTL', () => {
    let currentTime = Date.parse('2026-11-18T12:00:00Z');
    const store = new BranchContextStore(
      makeConfig({ maxSize: 2, ttlMs: 10 * 60 * 1000 }),
      () => currentTime
    );
    const chatId = -1003;

    store.recordNode({
      chatId,
      messageId: 1,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'U1',
      text: 'one',
      createdAt: currentTime,
    });
    store.recordNode({
      chatId,
      messageId: 2,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'U2',
      text: 'two',
      createdAt: currentTime,
    });
    store.recordNode({
      chatId,
      messageId: 3,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'U3',
      text: 'three',
      createdAt: currentTime,
    });

    assert.equal(store.contains(chatId, 1), false);
    assert.equal(store.contains(chatId, 2), true);
    assert.equal(store.contains(chatId, 3), true);

    // Advance beyond 10-minute TTL
    currentTime += 11 * 60 * 1000;
    assert.equal(store.contains(chatId, 2), false);
    assert.equal(store.contains(chatId, 3), false);
  });

  it('trims oldest ancestors when branch exceeds maxContextChars while always keeping leaf', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const config = createConfig({
      systemPrompt: 'Sys',
      branchMaxDepth: 10,
      branchMaxContextChars: 60,
    });
    const store = new BranchContextStore(config, () => now);
    const chatId = -1004;

    store.recordNode({
      chatId,
      messageId: 1,
      parentMessageId: null,
      role: BranchRole.USER,
      authorLabel: 'A',
      text: 'Очень старое длинное сообщение 11111111111111111111',
      createdAt: now,
    });
    store.recordNode({
      chatId,
      messageId: 2,
      parentMessageId: 1,
      role: BranchRole.ASSISTANT,
      authorLabel: 'bot',
      text: 'Ответ бота номер один 2222222222',
      createdAt: now + 1000,
    });
    store.recordNode({
      chatId,
      messageId: 3,
      parentMessageId: 2,
      role: BranchRole.USER,
      authorLabel: 'B',
      text: 'Короткий вопрос',
      createdAt: now + 2000,
    });

    const prompt = store.buildPromptMessages(chatId, 3);
    assert.equal(prompt.length, 3); // system + msg 2 + msg 3 (msg 1 trimmed by budget)
    assert.match(prompt[1].content, /Ответ бота номер один/);
    assert.match(prompt[2].content, /Короткий вопрос/);
  });
});
