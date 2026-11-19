import {
  extractText,
  hasBotMention,
  parseBotCommand,
  parseSearchCommand,
} from './message-extractor.js';

/**
 * Decides whether an incoming Telegram message should trigger a response.
 */
export const TriggerDecision = Object.freeze({
  IGNORE: 'IGNORE',
  PRIVATE_START: 'PRIVATE_START',
  USER_ID: 'USER_ID',
  ADMIN_PROMPT: 'ADMIN_PROMPT',
  ADMIN_SET_PROMPT: 'ADMIN_SET_PROMPT',
  ADMIN_RESET_PROMPT: 'ADMIN_RESET_PROMPT',
  ADMIN_DENIED: 'ADMIN_DENIED',
  SEARCH: 'SEARCH',
  ANSWER: 'ANSWER',
});

const ADMIN_COMMANDS = new Map([
  ['prompt', TriggerDecision.ADMIN_PROMPT],
  ['setprompt', TriggerDecision.ADMIN_SET_PROMPT],
  ['resetprompt', TriggerDecision.ADMIN_RESET_PROMPT],
]);

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

function isAdminUser(sender, config) {
  if (!sender || typeof sender.id !== 'number') {
    return false;
  }
  const admins = config?.adminUserIds;
  return admins != null && admins.size > 0 && admins.has(sender.id);
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

  const inPrivate = isPrivateChat(message.chat);
  const inGroup = isGroupChat(message.chat);
  if (!inPrivate && !inGroup) {
    return TriggerDecision.IGNORE;
  }

  const parsedCommand = parseBotCommand(text, botUsername);
  const admin = isAdminUser(sender, config);

  // Allow configured admins to manage prompt settings in private chat even if ALLOWED_CHAT_IDS restricts groups
  const isPrivateAdminCommand =
    inPrivate &&
    admin &&
    parsedCommand !== null &&
    (ADMIN_COMMANDS.has(parsedCommand.command) || parsedCommand.command === 'id');

  const allowed = config?.allowedChatIds;
  if (!isPrivateAdminCommand && allowed && allowed.size > 0 && !allowed.has(message.chat.id)) {
    return TriggerDecision.IGNORE;
  }

  if (parsedCommand !== null) {
    if (parsedCommand.command === 'start' && inPrivate) {
      return TriggerDecision.PRIVATE_START;
    }

    if (parsedCommand.command === 'id') {
      return inPrivate || parsedCommand.addressedToBot
        ? TriggerDecision.USER_ID
        : TriggerDecision.IGNORE;
    }

    const adminDecision = ADMIN_COMMANDS.get(parsedCommand.command);
    if (adminDecision) {
      if (admin) {
        return adminDecision;
      }
      return inPrivate ? TriggerDecision.ADMIN_DENIED : TriggerDecision.IGNORE;
    }
  }

  if (parseSearchCommand(text, botUsername) !== null) {
    return TriggerDecision.SEARCH;
  }

  if (inPrivate) {
    return TriggerDecision.ANSWER;
  }

  const mentioned = hasBotMention(message, botId, botUsername);
  const repliedToBot =
    message.reply_to_message != null &&
    message.reply_to_message.from != null &&
    message.reply_to_message.from.id === botId;

  return mentioned || repliedToBot ? TriggerDecision.ANSWER : TriggerDecision.IGNORE;
}
