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

  it('triggers SEARCH on /search, /search@bot, and @bot /search in both DM and groups', () => {
    const config = createConfig();
    const group = { id: -100, type: 'supergroup' };
    const dm = { id: 500, type: 'private' };

    assert.equal(
      evaluateTrigger(
        { message_id: 1, chat: group, from: human(10), text: '/search курс доллара' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.SEARCH
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 2, chat: group, from: human(10), text: '/search@Answering_Bot погода' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.SEARCH
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 3, chat: group, from: human(10), text: '@answering_bot /search новости' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.SEARCH
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 4, chat: dm, from: human(500), text: '/search свежие новости' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.SEARCH
    );
    // Command explicitly addressed to another bot in a group should be ignored
    assert.equal(
      evaluateTrigger(
        { message_id: 5, chat: group, from: human(10), text: '/search@other_bot новости' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.IGNORE
    );
  });

  it('handles admin prompt commands and /id with Telegram user ID authorization', () => {
    const config = createConfig({ ownerId: 42, allowedChatIds: [-100] });
    const dmAdmin = { id: 42, type: 'private' };
    const dmOther = { id: 99, type: 'private' };
    const group = { id: -100, type: 'supergroup' };

    // Admin in DM bypasses allowedChatIds for admin commands and /id
    assert.equal(
      evaluateTrigger(
        { message_id: 1, chat: dmAdmin, from: human(42), text: '/prompt' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.ADMIN_PROMPT
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 2, chat: dmAdmin, from: human(42), text: '/setprompt Будь вежливым.' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.ADMIN_SET_PROMPT
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 3, chat: dmAdmin, from: human(42), text: '/resetprompt' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.ADMIN_RESET_PROMPT
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 4, chat: dmAdmin, from: human(42), text: '/id' },
        BOT_ID,
        BOT_USERNAME,
        config
      ),
      TriggerDecision.USER_ID
    );

    // Non-admin in open DM gets ADMIN_DENIED; non-admin in group is silently ignored
    const openConfig = createConfig({ ownerId: 42 });
    assert.equal(
      evaluateTrigger(
        { message_id: 5, chat: dmOther, from: human(99), text: '/setprompt взлом' },
        BOT_ID,
        BOT_USERNAME,
        openConfig
      ),
      TriggerDecision.ADMIN_DENIED
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 6, chat: group, from: human(99), text: '/setprompt взлом' },
        BOT_ID,
        BOT_USERNAME,
        openConfig
      ),
      TriggerDecision.IGNORE
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 7, chat: dmOther, from: human(99), text: '/id' },
        BOT_ID,
        BOT_USERNAME,
        openConfig
      ),
      TriggerDecision.USER_ID
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 8, chat: group, from: human(99), text: '/id' },
        BOT_ID,
        BOT_USERNAME,
        openConfig
      ),
      TriggerDecision.IGNORE
    );
    assert.equal(
      evaluateTrigger(
        { message_id: 9, chat: group, from: human(99), text: '/id@answering_bot' },
        BOT_ID,
        BOT_USERNAME,
        openConfig
      ),
      TriggerDecision.USER_ID
    );
  });
});
