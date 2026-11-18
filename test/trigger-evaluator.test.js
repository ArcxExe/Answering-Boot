import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConfig } from '../tgcloud/lib/config.js';
import { evaluateTrigger, TriggerDecision } from '../tgcloud/lib/trigger-evaluator.js';

const BOT_ID = 999;
const BOT_USERNAME = 'answering_bot';

function human(id) {
  return { id, first_name: 'User', is_bot: false };
}

describe('trigger-evaluator', () => {
  it('triggers in group on text mention and caption mention', () => {
    const config = createConfig();
    const group = { id: -100, type: 'supergroup' };

    const textMention = {
      message_id: 1,
      chat: group,
      from: human(10),
      text: '@Answering_Bot когда день рождения у codex?',
      entities: [{ type: 'mention', offset: 0, length: 14 }],
    };

    const captionMention = {
      message_id: 2,
      chat: group,
      from: human(10),
      caption: 'Посмотри @answering_bot',
      caption_entities: [{ type: 'mention', offset: 9, length: 14 }],
    };

    assert.equal(evaluateTrigger(textMention, BOT_ID, BOT_USERNAME, config), TriggerDecision.ANSWER);
    assert.equal(
      evaluateTrigger(captionMention, BOT_ID, BOT_USERNAME, config),
      TriggerDecision.ANSWER
    );
  });

  it('triggers in group on reply to bot message without mention', () => {
    const config = createConfig();
    const group = { id: -100, type: 'group' };

    const botMessage = {
      message_id: 5,
      chat: group,
      from: { id: BOT_ID, first_name: 'Bot', is_bot: true },
      text: 'Ответ бота',
    };

    const followUp = {
      message_id: 6,
      chat: group,
      from: human(10),
      text: 'А поподробнее?',
      reply_to_message: botMessage,
    };

    assert.equal(evaluateTrigger(followUp, BOT_ID, BOT_USERNAME, config), TriggerDecision.ANSWER);
  });

  it('ignores group chatter without mention or bot reply', () => {
    const config = createConfig();
    const group = { id: -100, type: 'supergroup' };

    const normalMessage = {
      message_id: 7,
      chat: group,
      from: human(10),
      text: 'Привет всем в чате',
    };

    const replyToOtherUser = {
      message_id: 8,
      chat: group,
      from: human(11),
      text: 'Согласен',
      reply_to_message: normalMessage,
    };

    assert.equal(
      evaluateTrigger(normalMessage, BOT_ID, BOT_USERNAME, config),
      TriggerDecision.IGNORE
    );
    assert.equal(
      evaluateTrigger(replyToOtherUser, BOT_ID, BOT_USERNAME, config),
      TriggerDecision.IGNORE
    );
  });

  it('ignores disallowed chats when allowlist is configured', () => {
    const config = createConfig({ allowedChatIds: [100] });

    const disallowed = {
      message_id: 1,
      chat: { id: 200, type: 'supergroup' },
      from: human(10),
      text: '@answering_bot вопрос',
    };

    const allowed = {
      message_id: 2,
      chat: { id: 100, type: 'supergroup' },
      from: human(10),
      text: '@answering_bot вопрос',
    };

    assert.equal(evaluateTrigger(disallowed, BOT_ID, BOT_USERNAME, config), TriggerDecision.IGNORE);
    assert.equal(evaluateTrigger(allowed, BOT_ID, BOT_USERNAME, config), TriggerDecision.ANSWER);
  });

  it('returns PRIVATE_START on DM /start command and ANSWER on DM text', () => {
    const config = createConfig();
    const dm = { id: 500, type: 'private' };

    const start = {
      message_id: 1,
      chat: dm,
      from: human(500),
      text: '/start',
    };

    const startWithHandle = {
      message_id: 2,
      chat: dm,
      from: human(500),
      text: '/start@Answering_Bot payload',
    };

    const dmQuestion = {
      message_id: 3,
      chat: dm,
      from: human(500),
      text: 'Что такое Telegram Serverless?',
    };

    assert.equal(
      evaluateTrigger(start, BOT_ID, BOT_USERNAME, config),
      TriggerDecision.PRIVATE_START
    );
    assert.equal(
      evaluateTrigger(startWithHandle, BOT_ID, BOT_USERNAME, config),
      TriggerDecision.PRIVATE_START
    );
    assert.equal(evaluateTrigger(dmQuestion, BOT_ID, BOT_USERNAME, config), TriggerDecision.ANSWER);
  });

  it('ignores own messages and other bots', () => {
    const config = createConfig();
    const dm = { id: 500, type: 'private' };

    const selfMessage = {
      message_id: 1,
      chat: dm,
      from: { id: BOT_ID, first_name: 'Bot', is_bot: true },
      text: 'Мой ответ',
    };

    const otherBotMessage = {
      message_id: 2,
      chat: { id: -100, type: 'group' },
      from: { id: 777, first_name: 'OtherBot', is_bot: true },
      text: '@answering_bot привет',
    };

    assert.equal(evaluateTrigger(selfMessage, BOT_ID, BOT_USERNAME, config), TriggerDecision.IGNORE);
    assert.equal(
      evaluateTrigger(otherBotMessage, BOT_ID, BOT_USERNAME, config),
      TriggerDecision.IGNORE
    );
  });
});
