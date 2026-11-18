import { BranchRole } from './branch-context-store.js';
import {
  extractAuthorLabel,
  extractForwardedFrom,
  extractText,
  parseBotCommand,
  parseSearchCommand,
  splitForTelegram,
  stripBotMention,
} from './message-extractor.js';
import { evaluateTrigger, TriggerDecision } from './trigger-evaluator.js';

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const MAX_SYSTEM_PROMPT_LENGTH = 4000;
export const DEFAULT_FORWARD_PROMPT =
  'Дай краткий и информативный ответ или пояснение по этому сообщению.';
export const DEFAULT_SEARCH_REPLY_PROMPT =
  'Найди актуальную информацию и проверь факты по этому сообщению.';
export const UNSUPPORTED_EMPTY_REPLY_NOTICE =
  'Уточните вопрос или ответьте на текстовое сообщение (или пост с подписью).';
export const LLM_ERROR_REPLY =
  'Не удалось получить ответ от нейросети. Попробуйте чуть позже.';
export const SEARCH_USAGE_REPLY =
  'Укажите запрос после команды.\nПример: /search курс доллара сегодня';
export const SEARCH_UNAVAILABLE_REPLY = 'Поиск недоступен: не настроен GEMINI_API.';
export const SEARCH_ERROR_REPLY =
  'Не удалось выполнить поиск через Gemini. Попробуйте чуть позже.';
export const ADMIN_DENIED_REPLY = 'У вас нет доступа к этой команде.';
export const SET_PROMPT_USAGE_REPLY =
  'Укажите новый системный промпт после команды.\nПример:\n/setprompt Отвечай кратко и по делу.';

function buildStartGreeting(botUsername) {
  const handle =
    typeof botUsername === 'string' && botUsername.trim().length > 0
      ? `@${botUsername.trim()}`
      : 'меня';
  return (
    'Привет! Добавьте меня в группу и отвечайте на пересланные или обычные сообщения с упоминанием ' +
    `${handle} — я отвечу кратко и по делу.\n` +
    'Для поиска актуальной информации в интернете используйте команду /search <запрос>.'
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
  settingsStore = null,
  llmService,
  searchLlmClient = null,
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

  async function resolveSystemPrompt() {
    if (settingsStore) {
      const customPrompt = await settingsStore.getSystemPrompt();
      if (typeof customPrompt === 'string' && customPrompt.trim().length > 0) {
        return { text: customPrompt.trim(), isCustom: true };
      }
    }
    return { text: config.systemPrompt, isCustom: false };
  }

  async function seedReplyParentIfMissing(chatId, replyTo, botId) {
    if (!replyTo || replyTo.message_id == null) {
      return false;
    }
    if (await contextStore.contains(chatId, replyTo.message_id)) {
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

    await contextStore.recordNode({
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

  async function sendChunkedReply(
    chatId,
    initialReplyToId,
    text,
    { recordInContext = false, botUsername = '' } = {}
  ) {
    const chunks = splitForTelegram(text, TELEGRAM_MAX_MESSAGE_LENGTH);
    let replyTargetId = initialReplyToId;
    for (const chunk of chunks) {
      const sent = await sendReply(chatId, replyTargetId, chunk);
      if (sent && sent.message_id != null) {
        if (recordInContext) {
          await contextStore.recordNode({
            chatId,
            messageId: sent.message_id,
            parentMessageId: replyTargetId,
            role: BranchRole.ASSISTANT,
            authorLabel: botUsername,
            forwardedFrom: null,
            text: chunk,
            createdAt: nowFn(),
          });
        }
        replyTargetId = sent.message_id;
      }
    }
  }

  async function handleAdminCommand(decision, incoming, botUsername) {
    const chatId = incoming.chat.id;
    const messageId = incoming.message_id;

    if (decision === TriggerDecision.ADMIN_DENIED) {
      await sendReply(chatId, messageId, ADMIN_DENIED_REPLY);
      return;
    }

    if (decision === TriggerDecision.ADMIN_PROMPT) {
      const { text, isCustom } = await resolveSystemPrompt();
      const label = isCustom ? 'пользовательский' : 'по умолчанию';
      await sendChunkedReply(chatId, messageId, `Текущий системный промпт (${label}):\n\n${text}`);
      return;
    }

    if (decision === TriggerDecision.ADMIN_SET_PROMPT) {
      if (!settingsStore) {
        await sendReply(chatId, messageId, 'Хранилище настроек не подключено.');
        return;
      }
      const rawText = extractText(incoming) ?? '';
      const parsed = parseBotCommand(rawText, botUsername);
      const nextPrompt = parsed?.args ?? '';
      if (nextPrompt.length === 0) {
        await sendReply(chatId, messageId, SET_PROMPT_USAGE_REPLY);
        return;
      }
      if (nextPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
        await sendReply(
          chatId,
          messageId,
          `Промпт слишком длинный (${nextPrompt.length} симв.). Максимум — ${MAX_SYSTEM_PROMPT_LENGTH} символов.`
        );
        return;
      }

      const result = await settingsStore.setSystemPrompt(nextPrompt);
      const confirmation =
        result && result.persisted === false
          ? 'Системный промпт обновлён временно (в памяти). Выполните `npx tgcloud migrate`, чтобы он сохранялся постоянно.'
          : 'Системный промпт обновлён и сохранён.';
      await sendReply(chatId, messageId, confirmation);
      return;
    }

    if (decision === TriggerDecision.ADMIN_RESET_PROMPT) {
      if (!settingsStore) {
        await sendReply(chatId, messageId, 'Хранилище настроек не подключено.');
        return;
      }
      const result = await settingsStore.resetSystemPrompt();
      const confirmation =
        result && result.persisted === false
          ? 'Системный промпт сброшен на стандартный временно (в памяти). Выполните `npx tgcloud migrate`, чтобы сохранить сброс.'
          : 'Системный промпт сброшен на стандартный.';
      await sendReply(chatId, messageId, confirmation);
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

      if (decision === TriggerDecision.USER_ID) {
        const userId = incoming.from?.id;
        const text =
          typeof userId === 'number'
            ? `Ваш Telegram ID: ${userId}`
            : 'Не удалось определить ваш Telegram ID.';
        await sendReply(chatId, incoming.message_id, text);
        return;
      }

      if (
        decision === TriggerDecision.ADMIN_DENIED ||
        decision === TriggerDecision.ADMIN_PROMPT ||
        decision === TriggerDecision.ADMIN_SET_PROMPT ||
        decision === TriggerDecision.ADMIN_RESET_PROMPT
      ) {
        await handleAdminCommand(decision, incoming, botUsername);
        return;
      }

      const isSearch = decision === TriggerDecision.SEARCH;
      if (isSearch && !searchLlmClient) {
        await sendReply(chatId, incoming.message_id, SEARCH_UNAVAILABLE_REPLY);
        return;
      }

      const replyTo = incoming.reply_to_message ?? null;
      const hasReplyParent = await seedReplyParentIfMissing(chatId, replyTo, botId);

      const rawText = extractText(incoming) ?? '';
      let cleanQuery;
      if (isSearch) {
        const parsedSearch = parseSearchCommand(rawText, botUsername);
        cleanQuery = stripBotMention(parsedSearch?.args ?? '', botUsername);
        if (cleanQuery.length === 0) {
          if (!hasReplyParent) {
            await sendReply(chatId, incoming.message_id, SEARCH_USAGE_REPLY);
            return;
          }
          cleanQuery = DEFAULT_SEARCH_REPLY_PROMPT;
        }
      } else {
        cleanQuery = stripBotMention(rawText, botUsername);
        if (cleanQuery.length === 0) {
          if (!hasReplyParent) {
            if (replyTo !== null) {
              await sendReply(chatId, incoming.message_id, UNSUPPORTED_EMPTY_REPLY_NOTICE);
            }
            return;
          }
          cleanQuery = DEFAULT_FORWARD_PROMPT;
        }
      }

      const parentMessageId = hasReplyParent ? replyTo.message_id : null;
      await contextStore.recordNode({
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
        const { text: activeSystemPrompt } = await resolveSystemPrompt();
        const promptMessages = await contextStore.buildPromptMessages(
          chatId,
          incoming.message_id,
          activeSystemPrompt
        );

        if (isSearch) {
          const rawSearchAnswer = await searchLlmClient.ask(promptMessages);
          answer = typeof rawSearchAnswer === 'string' ? rawSearchAnswer.trim() : '';
          if (answer.length === 0) {
            throw new Error('Gemini search returned an empty response');
          }
        } else {
          answer = await llmService.generateAnswer(promptMessages);
        }
      } catch (err) {
        const mode = isSearch ? 'Gemini search' : 'LLM generation';
        logger.error(
          `${mode} failed for chat ${chatId} message ${incoming.message_id}`,
          err
        );
        await sendReply(
          chatId,
          incoming.message_id,
          isSearch ? SEARCH_ERROR_REPLY : LLM_ERROR_REPLY
        );
        return;
      }

      await sendChunkedReply(chatId, incoming.message_id, answer, {
        recordInContext: true,
        botUsername,
      });
    },
  };
}
