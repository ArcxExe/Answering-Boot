import { extractText, hasBotMention } from './message-extractor.js';

/**
 * Decides whether an incoming Telegram message should trigger a response.
 */
export const TriggerDecision = Object.freeze({
  IGNORE: 'IGNORE',
  PRIVATE_START: 'PRIVATE_START',
  ANSWER: 'ANSWER',
});

function isPrivateChat(chat) {
  return typeof chat?.type === 'string' && chat.type.toLowerCase() === 'private';
}

function isGroupChat(chat) {
  if (typeof chat?.type !== 'string') {
    return false;
  }
  const type = chat.type.toLowerCase();
  return type === 'group' || type === 'supergroup';
}

function isStartCommand(text, botUsername) {
  const firstToken = text.trim().split(/\s+/, 1)[0].toLowerCase();
  if (firstToken === '/start') {
    return true;
  }
  return (
    typeof botUsername === 'string' &&
    botUsername.trim().length > 0 &&
    firstToken === `/start@${botUsername.trim().toLowerCase()}`
  );
}

/**
 * Evaluates a Telegram Message and returns a TriggerDecision.
 */
export function evaluateTrigger(message, botId, botUsername, config) {
  if (!message || !message.chat) {
    return TriggerDecision.IGNORE;
  }

  const sender = message.from;
  if (sender && (sender.is_bot === true || sender.id === botId)) {
    return TriggerDecision.IGNORE;
  }

  const text = extractText(message);
  if (text === null) {
    return TriggerDecision.IGNORE;
  }

  const allowed = config?.allowedChatIds;
  if (allowed && allowed.size > 0 && !allowed.has(message.chat.id)) {
    return TriggerDecision.IGNORE;
  }

  if (isPrivateChat(message.chat)) {
    return isStartCommand(text, botUsername)
      ? TriggerDecision.PRIVATE_START
      : TriggerDecision.ANSWER;
  }

  if (isGroupChat(message.chat)) {
    const mentioned = hasBotMention(message, botId, botUsername);
    const repliedToBot =
      message.reply_to_message != null &&
      message.reply_to_message.from != null &&
      message.reply_to_message.from.id === botId;

    return mentioned || repliedToBot ? TriggerDecision.ANSWER : TriggerDecision.IGNORE;
  }

  return TriggerDecision.IGNORE;
}
