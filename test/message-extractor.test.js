import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractAuthorLabel,
  extractForwardedFrom,
  extractText,
  hasBotMention,
  splitForTelegram,
  stripBotMention,
} from '../tgcloud/lib/message-extractor.js';

describe('message-extractor', () => {
  it('extracts caption when text is absent', () => {
    const message = {
      message_id: 1,
      chat: { id: -100, type: 'supergroup' },
      caption: '  Пост про Codex  ',
    };

    assert.equal(extractText(message), 'Пост про Codex');
  });

  it('returns null when text and caption are missing or blank', () => {
    assert.equal(extractText({ message_id: 1, text: '   ' }), null);
    assert.equal(extractText({ message_id: 2 }), null);
  });

  it('extracts forward_origin for user, channel, chat, hidden_user, and legacy fields', () => {
    const fromUser = {
      forward_origin: {
        type: 'user',
        sender_user: { id: 42, first_name: 'Алексей', last_name: 'Петров', is_bot: false },
      },
    };
    const fromChannel = {
      forward_origin: {
        type: 'channel',
        chat: { id: -200, type: 'channel', title: 'Новости AI' },
      },
    };
    const fromChat = {
      forward_origin: {
        type: 'chat',
        sender_chat: { id: -201, type: 'supergroup', username: 'dev_chat' },
      },
    };
    const fromHidden = {
      forward_origin: {
        type: 'hidden_user',
        sender_user_name: 'Скрытый автор',
      },
    };
    const fromLegacyChat = {
      forward_from_chat: { id: -300, type: 'channel', title: 'Legacy Channel' },
    };
    const fromLegacyUser = {
      forward_from: { id: 55, username: 'legacy_user' },
    };

    assert.equal(extractForwardedFrom(fromUser), 'Алексей Петров');
    assert.equal(extractForwardedFrom(fromChannel), 'Новости AI');
    assert.equal(extractForwardedFrom(fromChat), '@dev_chat');
    assert.equal(extractForwardedFrom(fromHidden), 'Скрытый автор');
    assert.equal(extractForwardedFrom(fromLegacyChat), 'Legacy Channel');
    assert.equal(extractForwardedFrom(fromLegacyUser), '@legacy_user');
  });

  it('formats author label with fallback to username and default', () => {
    assert.equal(extractAuthorLabel({ from: { first_name: 'Иван', last_name: 'Иванов' } }), 'Иван Иванов');
    assert.equal(extractAuthorLabel({ from: { username: 'ivan_dev' } }), '@ivan_dev');
    assert.equal(extractAuthorLabel({}), 'Пользователь');
  });

  it('detects mentions via entities, text_mention, caption_entities, and regex fallback', () => {
    const viaEntity = {
      text: '@Answering_Bot привет',
      entities: [{ type: 'mention', offset: 0, length: 14 }],
    };
    const viaTextMention = {
      text: 'Подсолнух привет',
      entities: [{ type: 'text_mention', offset: 0, length: 9, user: { id: 999 } }],
    };
    const viaCaption = {
      caption: 'Глянь @answering_bot',
      caption_entities: [{ type: 'mention', offset: 6, length: 14 }],
    };
    const viaPlainFallback = {
      text: 'Эй, @ANSWERING_BOT!',
    };
    const partialUsername = {
      text: '@answering_bot_extra привет',
    };

    assert.equal(hasBotMention(viaEntity, 999, 'answering_bot'), true);
    assert.equal(hasBotMention(viaTextMention, 999, 'answering_bot'), true);
    assert.equal(hasBotMention(viaCaption, 999, 'answering_bot'), true);
    assert.equal(hasBotMention(viaPlainFallback, 999, 'answering_bot'), true);
    assert.equal(hasBotMention(partialUsername, 999, 'answering_bot'), false);
  });

  it('strips bot mention case-insensitively without damaging surrounding text', () => {
    assert.equal(
      stripBotMention('@My_Bot когда день рождения?', 'my_bot'),
      'когда день рождения?'
    );
    assert.equal(stripBotMention('  @MY_BOT  ', 'my_bot'), '');
    assert.equal(
      stripBotMention('Привет  @my_bot   расскажи про JS', 'my_bot'),
      'Привет расскажи про JS'
    );
  });

  it('splits long replies within the 4096 Telegram character limit', () => {
    const unit = `${'Слово '.repeat(20)}\n`;
    const longText = unit.repeat(90); // > 9000 chars

    const parts = splitForTelegram(longText, 4096);

    assert.ok(parts.length > 1);
    for (const part of parts) {
      assert.ok(part.length <= 4096);
    }
    assert.equal(
      parts.join('\n').replace(/\s+/g, ' ').trim(),
      longText.replace(/\s+/g, ' ').trim()
    );
  });
});
