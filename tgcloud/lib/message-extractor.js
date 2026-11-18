/**
 * Pure helper functions for reading text, forward origin, mentions, and splitting replies for Telegram.
 */

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMentionRegex(botUsername, flags = 'i') {
  return new RegExp(`(?<!\\S)@${escapeRegExp(botUsername)}(?![A-Za-z0-9_])`, flags);
}

export function formatUser(user) {
  if (!user) {
    return 'Пользователь';
  }
  const first = typeof user.first_name === 'string' ? user.first_name.trim() : '';
  const last = typeof user.last_name === 'string' ? user.last_name.trim() : '';
  const fullName = `${first} ${last}`.trim();
  if (fullName.length > 0) {
    return fullName;
  }
  if (typeof user.username === 'string' && user.username.trim().length > 0) {
    return `@${user.username.trim()}`;
  }
  return 'Пользователь';
}

export function formatChat(chat) {
  if (!chat) {
    return 'Чат';
  }
  if (typeof chat.title === 'string' && chat.title.trim().length > 0) {
    return chat.title.trim();
  }
  if (typeof chat.username === 'string' && chat.username.trim().length > 0) {
    return `@${chat.username.trim()}`;
  }
  return 'Чат';
}

export function extractText(message) {
  if (!message) {
    return null;
  }
  const raw = message.text ?? message.caption;
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractAuthorLabel(message) {
  if (!message || !message.from) {
    return 'Пользователь';
  }
  return formatUser(message.from);
}

export function extractForwardedFrom(message) {
  if (!message) {
    return null;
  }

  const origin = message.forward_origin;
  if (origin && typeof origin === 'object') {
    switch (origin.type) {
      case 'user':
        return origin.sender_user ? formatUser(origin.sender_user) : null;
      case 'channel':
        return origin.chat ? formatChat(origin.chat) : null;
      case 'chat':
        return origin.sender_chat ? formatChat(origin.sender_chat) : null;
      case 'hidden_user':
        return typeof origin.sender_user_name === 'string' && origin.sender_user_name.trim().length > 0
          ? origin.sender_user_name.trim()
          : null;
      default:
        return null;
    }
  }

  if (message.forward_from_chat) {
    return formatChat(message.forward_from_chat);
  }
  if (message.forward_from) {
    return formatUser(message.forward_from);
  }
  return null;
}

function extractEntitySlice(content, entity) {
  if (typeof entity.text === 'string') {
    return entity.text;
  }
  if (
    typeof content !== 'string' ||
    typeof entity.offset !== 'number' ||
    typeof entity.length !== 'number'
  ) {
    return '';
  }
  const start = entity.offset;
  const end = Math.min(content.length, start + entity.length);
  if (start < 0 || start >= end) {
    return '';
  }
  return content.slice(start, end);
}

function matchesMentionEntities(content, entities, botId, botUsername) {
  if (!Array.isArray(entities) || entities.length === 0) {
    return false;
  }
  const expectedMention =
    typeof botUsername === 'string' && botUsername.trim().length > 0
      ? `@${botUsername.trim().toLowerCase()}`
      : null;

  for (const entity of entities) {
    if (!entity) {
      continue;
    }
    if (entity.type === 'text_mention' && entity.user && entity.user.id === botId) {
      return true;
    }
    if (entity.type === 'mention' && expectedMention !== null) {
      const slice = extractEntitySlice(content, entity);
      if (slice.toLowerCase() === expectedMention) {
        return true;
      }
    }
  }
  return false;
}

export function hasBotMention(message, botId, botUsername) {
  if (!message) {
    return false;
  }
  if (matchesMentionEntities(message.text, message.entities, botId, botUsername)) {
    return true;
  }
  if (matchesMentionEntities(message.caption, message.caption_entities, botId, botUsername)) {
    return true;
  }
  if (typeof botUsername !== 'string' || botUsername.trim().length === 0) {
    return false;
  }
  const text = extractText(message);
  if (text === null) {
    return false;
  }
  return buildMentionRegex(botUsername.trim(), 'i').test(text);
}

export function stripBotMention(text, botUsername) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return '';
  }
  if (typeof botUsername !== 'string' || botUsername.trim().length === 0) {
    return text.trim();
  }
  return text
    .replace(buildMentionRegex(botUsername.trim(), 'gi'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function findSplitIndex(text, maxLength) {
  const half = Math.floor(maxLength / 2);
  const newline = text.lastIndexOf('\n', maxLength);
  if (newline > half) {
    return newline;
  }
  const space = text.lastIndexOf(' ', maxLength);
  if (space > half) {
    return space;
  }
  return maxLength;
}

export function splitForTelegram(text, maxLength = 4096) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new RangeError('maxLength must be positive');
  }

  let remaining = text.trim();
  if (remaining.length <= maxLength) {
    return [remaining];
  }

  const chunks = [];
  while (remaining.length > maxLength) {
    const splitAt = findSplitIndex(remaining, maxLength);
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}
