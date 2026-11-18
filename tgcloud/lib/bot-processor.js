import { BranchRole } from './branch-context-store.js';
import {
  extractAuthorLabel,
  extractForwardedFrom,
  extractText,
  splitForTelegram,
  stripBotMention,
} from './message-extractor.js';
import { evaluateTrigger, TriggerDecision } from './trigger-evaluator.js';

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const DEFAULT_FORWARD_PROMPT =
  'Дай краткий и информативный ответ или пояснение по этому сообщению.';
export const UNSUPPORTED_EMPTY_REPLY_NOTICE =
  'Уточните вопрос или ответьте на текстовое сообщение (или пост с подписью).';
export const LLM_ERROR_REPLY =
  'Не удалось получить ответ от нейросети. Попробуйте чуть позже.';

function buildStartGreeting(botUsername) {
  const handle =
    typeof botUsername === 'string' && botUsername.trim().length > 0
      ? `@${botUsername.trim()}`
      : 'меня';
  return (
    'Привет! Добавьте меня в группу и отвечайте на пересланные или обычные сообщения с упоминанием ' +
    `${handle} — я отвечу кратко и по делу.`
  );
}

/**
 * Creates the stateless-friendly message processor for Telegram Serverless.
 * Dependencies are injected so the entire processor can be tested offline in Node.js.
 */
export function createBotProcessor({
  api,
  config,
  contextStore,
  llmService,
  nowFn = () => Date.now(),
  logger = console,
}) {
  let cachedIdentity =
    config.botId !== null && config.botUsername
      ? { id: config.botId, username: config.botUsername }
      : null;

  async function resolveBotIdentity() {
    if (cachedIdentity) {
      return cachedIdentity;
    }
    const me = await api.getMe();
    cachedIdentity = {
      id: me.id,
      username: typeof me.username === 'string' ? me.username : '',
    };
    return cachedIdentity;
  }

  function seedReplyParentIfMissing(chatId, replyTo, botId) {
    if (!replyTo || replyTo.message_id == null) {
      return false;
    }
    if (contextStore.contains(chatId, replyTo.message_id)) {
      return true;
    }
    const text = extractText(replyTo);
    if (text === null) {
      return false;
    }
    const role =
      replyTo.from != null && replyTo.from.id === botId
        ? BranchRole.ASSISTANT
        : BranchRole.USER;

    contextStore.recordNode({
      chatId,
      messageId: replyTo.message_id,
      parentMessageId: null,
      role,
      authorLabel: extractAuthorLabel(replyTo),
      forwardedFrom: extractForwardedFrom(replyTo),
      text,
      createdAt: nowFn(),
    });
    return true;
  }

  async function sendTyping(chatId) {
    try {
      await api.sendChatAction({ chat_id: chatId, action: 'typing' });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.debug(`Failed to send typing action to chat ${chatId}: ${detail}`);
    }
  }

  async function sendReply(chatId, replyToMessageId, text) {
    try {
      return await api.sendMessage({
        chat_id: chatId,
        text,
        reply_parameters: {
          message_id: replyToMessageId,
          allow_sending_without_reply: true,
        },
      });
    } catch (err) {
      logger.error(`Failed to send Telegram reply in chat ${chatId}`, err);
      return null;
    }
  }

  return {
    async processMessage(incoming) {
      if (!config.enabled || !incoming || !incoming.chat) {
        return;
      }

      const { id: botId, username: botUsername } = await resolveBotIdentity();
      const decision = evaluateTrigger(incoming, botId, botUsername, config);
      if (decision === TriggerDecision.IGNORE) {
        return;
      }

      const chatId = incoming.chat.id;
      if (decision === TriggerDecision.PRIVATE_START) {
        await sendReply(chatId, incoming.message_id, buildStartGreeting(botUsername));
        return;
      }

      const replyTo = incoming.reply_to_message ?? null;
      const hasReplyParent = seedReplyParentIfMissing(chatId, replyTo, botId);

      const rawText = extractText(incoming) ?? '';
      let cleanQuery = stripBotMention(rawText, botUsername);
      if (cleanQuery.length === 0) {
        if (!hasReplyParent) {
          if (replyTo !== null) {
            await sendReply(chatId, incoming.message_id, UNSUPPORTED_EMPTY_REPLY_NOTICE);
          }
          return;
        }
        cleanQuery = DEFAULT_FORWARD_PROMPT;
      }

      const parentMessageId = hasReplyParent ? replyTo.message_id : null;
      contextStore.recordNode({
        chatId,
        messageId: incoming.message_id,
        parentMessageId,
        role: BranchRole.USER,
        authorLabel: extractAuthorLabel(incoming),
        forwardedFrom: extractForwardedFrom(incoming),
        text: cleanQuery,
        createdAt: nowFn(),
      });

      await sendTyping(chatId);

      let answer;
      try {
        const promptMessages = contextStore.buildPromptMessages(chatId, incoming.message_id);
        answer = await llmService.generateAnswer(promptMessages);
      } catch (err) {
        logger.error(
          `LLM generation failed for chat ${chatId} message ${incoming.message_id}`,
          err
        );
        await sendReply(chatId, incoming.message_id, LLM_ERROR_REPLY);
        return;
      }

      const chunks = splitForTelegram(answer, TELEGRAM_MAX_MESSAGE_LENGTH);
      let replyTargetId = incoming.message_id;
      for (const chunk of chunks) {
        const sent = await sendReply(chatId, replyTargetId, chunk);
        if (sent && sent.message_id != null) {
          contextStore.recordNode({
            chatId,
            messageId: sent.message_id,
            parentMessageId: replyTargetId,
            role: BranchRole.ASSISTANT,
            authorLabel: botUsername,
            forwardedFrom: null,
            text: chunk,
            createdAt: nowFn(),
          });
          replyTargetId = sent.message_id;
        }
      }
    },
  };
}
