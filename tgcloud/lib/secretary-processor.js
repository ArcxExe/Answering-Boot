import { BranchRole } from './branch-context-store.js';
import {
  extractAuthorLabel,
  extractText,
  parseBotCommand,
  splitForTelegram,
} from './message-extractor.js';
import { TriggerDecision } from './trigger-evaluator.js';

export const SECRETARY_MAX_MESSAGE_LENGTH = 4096;
export const SECRETARY_MAX_PROMPT_LENGTH = 4000;
export const SECRETARY_MAX_QUOTE_LENGTH = 400;
export const SECRETARY_ACCESS_DENIED_REPLY =
  'Режим секретаря ограничен владельцем бота (настройка OWNER_ID).';
export const SECRETARY_SET_PROMPT_USAGE_REPLY =
  'Укажите системный промпт для режима секретаря после команды.\n' +
  'Пример:\n/set_secretary_prompt Ты мой личный секретарь. Отвечай вежливо и кратко.';

const CALLBACK_PATTERN = /^sec:(pause|resume|clear):(-?\d+)$/;

function formatRightsFlag(enabled) {
  return enabled ? '✅ разрешено' : '❌ нет';
}

function buildManageChatText(targetChatId, paused, notice = null) {
  const statusLine = paused
    ? '⏸ Режим секретаря в этом чате приостановлен.'
    : '▶️ Режим секретаря активен в этом чате.';
  const lines = [`Управление чатом ${targetChatId}`, statusLine];
  if (notice) {
    lines.push('', notice);
  }
  return lines.join('\n');
}

function buildManageChatKeyboard(targetChatId, paused) {
  return {
    inline_keyboard: [
      [
        paused
          ? { text: '▶️ Включить секретаря в этом чате', callback_data: `sec:resume:${targetChatId}` }
          : { text: '⏸ Приостановить секретаря в этом чате', callback_data: `sec:pause:${targetChatId}` },
      ],
      [{ text: '🧹 Очистить память этого чата', callback_data: `sec:clear:${targetChatId}` }],
    ],
  };
}

function formatIncomingWithReplyQuote(text, replyText) {
  if (!replyText) {
    return text;
  }
  const compactQuote =
    replyText.length > SECRETARY_MAX_QUOTE_LENGTH
      ? `${replyText.slice(0, SECRETARY_MAX_QUOTE_LENGTH)}…`
      : replyText;
  return `[В ответ на «${compactQuote}»]: ${text}`;
}

/**
 * Telegram Business Bot (Secretary Mode) processor.
 * Handles `business_connection`, `business_message`, `edited_business_message`,
 * `deleted_business_messages`, `/start bizChat<id>`, inline buttons, and owner commands.
 */
export function createSecretaryProcessor({
  api,
  config,
  businessStore,
  settingsStore = null,
  llmService,
  nowFn = () => Date.now(),
  logger = console,
}) {
  function isAuthorizedUser(userId) {
    if (!config.secretaryEnabled || typeof userId !== 'number') {
      return false;
    }
    if (config.secretaryAllowAll || config.adminUserIds.size === 0) {
      return true;
    }
    return config.adminUserIds.has(userId);
  }

  async function resolveSecretaryPrompt(userId) {
    if (settingsStore) {
      const custom = await settingsStore.getSecretaryPrompt(userId);
      if (typeof custom === 'string' && custom.trim().length > 0) {
        return { text: custom.trim(), isCustom: true };
      }
    }
    return { text: config.secretarySystemPrompt, isCustom: false };
  }

  async function sendDirectMessage(chatId, text, extra = {}) {
    try {
      return await api.sendMessage({
        chat_id: chatId,
        text,
        ...extra,
      });
    } catch (err) {
      logger.debug(
        `Failed to send direct secretary notice to chat ${chatId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  }

  async function sendDirectReply(chatId, replyToMessageId, text, extra = {}) {
    return sendDirectMessage(chatId, text, {
      reply_parameters: {
        message_id: replyToMessageId,
        allow_sending_without_reply: true,
      },
      ...extra,
    });
  }

  async function sendBusinessTyping(businessConnectionId, chatId) {
    try {
      await api.sendChatAction({
        business_connection_id: businessConnectionId,
        chat_id: chatId,
        action: 'typing',
      });
    } catch (err) {
      logger.debug(
        `Failed to send business typing action to chat ${chatId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async function resolveConnection(businessConnectionId) {
    const cached = await businessStore.getConnection(businessConnectionId);
    if (cached) {
      return cached;
    }
    if (typeof api.getBusinessConnection !== 'function') {
      return null;
    }
    try {
      const fresh = await api.getBusinessConnection({
        business_connection_id: businessConnectionId,
      });
      if (!fresh || !fresh.id) {
        return null;
      }
      const { connection } = await businessStore.upsertConnection(fresh);
      return connection;
    } catch (err) {
      logger.warn(
        `Failed to fetch business connection ${businessConnectionId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  }

  async function markMessageAsReadIfAllowed(connection, chatId, messageId) {
    if (
      !config.secretaryMarkAsRead ||
      !connection.canReadMessages ||
      typeof api.readBusinessMessage !== 'function'
    ) {
      return;
    }
    try {
      await api.readBusinessMessage({
        business_connection_id: connection.id,
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (err) {
      logger.debug(
        `Failed to mark business message ${messageId} as read: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    isAuthorizedUser,

    async handleBusinessConnection(rawConnection) {
      if (!config.enabled || !config.secretaryEnabled || !rawConnection?.id) {
        return;
      }

      const { connection } = await businessStore.upsertConnection(rawConnection);
      const authorized = isAuthorizedUser(connection.userId);

      if (!authorized) {
        if (connection.isEnabled) {
          await sendDirectMessage(connection.userChatId, SECRETARY_ACCESS_DENIED_REPLY);
        }
        return;
      }

      if (!connection.isEnabled) {
        await sendDirectMessage(
          connection.userChatId,
          'Режим секретаря отключён для вашего аккаунта.'
        );
        return;
      }

      const statusLines = [
        'Режим секретаря подключён!',
        `• Ответы на сообщения (can_reply): ${formatRightsFlag(connection.canReply)}`,
        `• Отметка о прочтении (can_read_messages): ${formatRightsFlag(connection.canReadMessages)}`,
        '',
        'Команды управления в этом чате:',
        '• /secretary — статус подключения и права',
        '• /secretary_prompt — текущий промпт секретаря',
        '• /set_secretary_prompt <текст> — задать промпт секретаря',
        '• /reset_secretary_prompt — сбросить промпт секретаря',
        '',
        'В верхней панели каждого управляемого чата кнопка «Manage Bot» позволяет приостановить секретаря или очистить историю конкретного диалога.',
      ];

      if (!connection.canReply) {
        statusLines.push(
          '',
          '⚠️ Право на отправку ответов сейчас выключено — бот будет только запоминать контекст, пока вы не включите право отвечать в настройках Telegram.'
        );
      }

      await sendDirectMessage(connection.userChatId, statusLines.join('\n'));
    },

    async handleBusinessMessage(message) {
      if (!config.enabled || !config.secretaryEnabled || !message) {
        return;
      }
      const businessConnectionId =
        typeof message.business_connection_id === 'string'
          ? message.business_connection_id.trim()
          : '';
      if (!businessConnectionId || !message.chat || message.chat.id == null) {
        return;
      }

      // Prevent infinite loops and skip automated Telegram offline/greeting/scheduled messages
      if (message.sender_business_bot || message.is_from_offline === true) {
        return;
      }
      if (message.from?.is_bot === true) {
        return;
      }

      const connection = await resolveConnection(businessConnectionId);
      if (!connection || !connection.isEnabled) {
        return;
      }
      if (!isAuthorizedUser(connection.userId)) {
        return;
      }

      const text = extractText(message);
      if (text === null) {
        return;
      }

      const chatId = message.chat.id;
      const isFromOwner = message.from?.id === connection.userId;

      // Record owner's manual outgoing messages so secretary stays aware of human replies
      if (isFromOwner) {
        await businessStore.recordMessage({
          businessConnectionId,
          chatId,
          messageId: message.message_id,
          role: BranchRole.ASSISTANT,
          authorLabel: extractAuthorLabel(message),
          text,
          createdAt: nowFn(),
        });
        return;
      }

      // If contact replied to an older message not in our window, preserve a compact quote
      let enrichedText = text;
      const replyTo = message.reply_to_message ?? null;
      if (replyTo && replyTo.message_id != null) {
        const alreadyStored = await businessStore.hasMessage(
          businessConnectionId,
          chatId,
          replyTo.message_id
        );
        if (!alreadyStored) {
          const replyText = extractText(replyTo);
          if (replyText) {
            enrichedText = formatIncomingWithReplyQuote(text, replyText);
          }
        }
      }

      await businessStore.recordMessage({
        businessConnectionId,
        chatId,
        messageId: message.message_id,
        role: BranchRole.USER,
        authorLabel: extractAuthorLabel(message),
        text: enrichedText,
        createdAt: nowFn(),
      });

      const paused = await businessStore.isChatPaused(connection.userId, chatId);
      if (paused || !connection.canReply) {
        return;
      }

      await sendBusinessTyping(businessConnectionId, chatId);

      let answer;
      try {
        const { text: activePrompt } = await resolveSecretaryPrompt(connection.userId);
        const promptMessages = await businessStore.buildPromptMessages(
          businessConnectionId,
          chatId,
          activePrompt
        );
        answer = await llmService.generateAnswer(promptMessages);
      } catch (err) {
        // Never send technical error notices to the account owner's personal contacts
        logger.error(
          `Secretary LLM generation failed for connection ${businessConnectionId} chat ${chatId}`,
          err
        );
        return;
      }

      const chunks = splitForTelegram(answer, SECRETARY_MAX_MESSAGE_LENGTH);
      let sentAtLeastOne = false;
      for (const chunk of chunks) {
        try {
          const sent = await api.sendMessage({
            business_connection_id: businessConnectionId,
            chat_id: chatId,
            text: chunk,
          });
          sentAtLeastOne = true;
          if (sent && sent.message_id != null) {
            await businessStore.recordMessage({
              businessConnectionId,
              chatId,
              messageId: sent.message_id,
              role: BranchRole.ASSISTANT,
              authorLabel: connection.userLabel,
              text: chunk,
              createdAt: nowFn(),
            });
          }
        } catch (err) {
          logger.error(
            `Failed to send business reply for connection ${businessConnectionId} chat ${chatId}`,
            err
          );
          break;
        }
      }

      if (sentAtLeastOne) {
        await markMessageAsReadIfAllowed(connection, chatId, message.message_id);
      }
    },

    async handleEditedBusinessMessage(message) {
      if (!config.enabled || !config.secretaryEnabled || !message) {
        return;
      }
      const businessConnectionId =
        typeof message.business_connection_id === 'string'
          ? message.business_connection_id.trim()
          : '';
      if (!businessConnectionId || !message.chat || message.chat.id == null || message.message_id == null) {
        return;
      }

      const text = extractText(message);
      if (text === null) {
        return;
      }
      await businessStore.updateMessageText(
        businessConnectionId,
        message.chat.id,
        message.message_id,
        text
      );
    },

    async handleDeletedBusinessMessages(deleted) {
      if (!config.enabled || !config.secretaryEnabled || !deleted) {
        return;
      }
      const businessConnectionId =
        typeof deleted.business_connection_id === 'string'
          ? deleted.business_connection_id.trim()
          : '';
      if (
        !businessConnectionId ||
        !deleted.chat ||
        deleted.chat.id == null ||
        !Array.isArray(deleted.message_ids) ||
        deleted.message_ids.length === 0
      ) {
        return;
      }
      await businessStore.deleteMessages(
        businessConnectionId,
        deleted.chat.id,
        deleted.message_ids
      );
    },

    async handleManageChatDeepLink(incoming, targetChatId) {
      const userId = incoming?.from?.id;
      const chatId = incoming?.chat?.id;
      if (typeof userId !== 'number' || chatId == null || !Number.isSafeInteger(targetChatId)) {
        return;
      }

      if (!isAuthorizedUser(userId)) {
        await sendDirectReply(chatId, incoming.message_id, SECRETARY_ACCESS_DENIED_REPLY);
        return;
      }

      const paused = await businessStore.isChatPaused(userId, targetChatId);
      await sendDirectReply(
        chatId,
        incoming.message_id,
        buildManageChatText(targetChatId, paused),
        {
          reply_markup: buildManageChatKeyboard(targetChatId, paused),
        }
      );
    },

    async handleCallbackQuery(callbackQuery) {
      if (!config.enabled || !config.secretaryEnabled || !callbackQuery) {
        return;
      }
      const data = typeof callbackQuery.data === 'string' ? callbackQuery.data : '';
      const match = CALLBACK_PATTERN.exec(data);
      if (!match) {
        return;
      }

      const userId = callbackQuery.from?.id;
      if (!isAuthorizedUser(userId)) {
        if (typeof api.answerCallbackQuery === 'function') {
          await api.answerCallbackQuery({
            callback_query_id: callbackQuery.id,
            text: 'Нет доступа к управлению секретарём.',
            show_alert: true,
          });
        }
        return;
      }

      const action = match[1];
      const targetChatId = Number(match[2]);
      let toast = '';
      let notice = null;
      let paused = await businessStore.isChatPaused(userId, targetChatId);

      if (action === 'pause') {
        await businessStore.setChatPaused(userId, targetChatId, true);
        paused = true;
        toast = 'Секретарь приостановлен в этом чате';
      } else if (action === 'resume') {
        await businessStore.setChatPaused(userId, targetChatId, false);
        paused = false;
        toast = 'Секретарь снова активен в этом чате';
      } else if (action === 'clear') {
        const connections = await businessStore.getConnectionsByUser(userId);
        for (const conn of connections) {
          await businessStore.clearChatHistory(conn.id, targetChatId);
        }
        toast = 'Память этого чата очищена';
        notice = '🧹 История переписки для этого чата очищена.';
      }

      if (typeof api.answerCallbackQuery === 'function') {
        try {
          await api.answerCallbackQuery({
            callback_query_id: callbackQuery.id,
            text: toast,
          });
        } catch (err) {
          logger.debug(
            `Failed to answer callback query: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const msg = callbackQuery.message;
      if (msg && msg.chat && msg.message_id != null && typeof api.editMessageText === 'function') {
        try {
          await api.editMessageText({
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            text: buildManageChatText(targetChatId, paused, notice),
            reply_markup: buildManageChatKeyboard(targetChatId, paused),
          });
        } catch (err) {
          logger.debug(
            `Failed to update manage-chat keyboard: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    },

    async handleOwnerCommand(decision, incoming, botUsername) {
      const userId = incoming?.from?.id;
      const chatId = incoming?.chat?.id;
      const messageId = incoming?.message_id;
      if (typeof userId !== 'number' || chatId == null) {
        return;
      }

      if (!isAuthorizedUser(userId)) {
        await sendDirectReply(chatId, messageId, SECRETARY_ACCESS_DENIED_REPLY);
        return;
      }

      if (decision === TriggerDecision.SECRETARY_STATUS) {
        const connections = await businessStore.getConnectionsByUser(userId);
        const active = connections.find((c) => c.isEnabled) ?? null;
        const pausedCount = await businessStore.countPausedChats(userId);

        if (!active) {
          await sendDirectReply(
            chatId,
            messageId,
            'Режим секретаря пока не подключён к вашему аккаунту.\n\n' +
              'Чтобы подключить:\n' +
              '1. Включите Secretary Mode (Business Mode) для бота в @BotFather.\n' +
              '2. В настройках Telegram подключите этого бота к своему аккаунту и выберите нужные чаты и права.'
          );
          return;
        }

        const lines = [
          'Статус режима секретаря: ✅ активен',
          `• Ответы на сообщения (can_reply): ${formatRightsFlag(active.canReply)}`,
          `• Отметка о прочтении (can_read_messages): ${formatRightsFlag(active.canReadMessages)}`,
          `• Чатов на паузе: ${pausedCount}`,
          '',
          'Команды:',
          '• /secretary_prompt — текущий промпт секретаря',
          '• /set_secretary_prompt <текст> — изменить промпт секретаря',
          '• /reset_secretary_prompt — сбросить промпт секретаря',
        ];
        await sendDirectReply(chatId, messageId, lines.join('\n'));
        return;
      }

      if (decision === TriggerDecision.SECRETARY_PROMPT) {
        const { text, isCustom } = await resolveSecretaryPrompt(userId);
        const label = isCustom ? 'пользовательский' : 'по умолчанию';
        const chunks = splitForTelegram(
          `Текущий промпт режима секретаря (${label}):\n\n${text}`,
          SECRETARY_MAX_MESSAGE_LENGTH
        );
        let replyTargetId = messageId;
        for (const chunk of chunks) {
          const sent = await sendDirectReply(chatId, replyTargetId, chunk);
          if (sent?.message_id != null) {
            replyTargetId = sent.message_id;
          }
        }
        return;
      }

      if (decision === TriggerDecision.SECRETARY_SET_PROMPT) {
        if (!settingsStore) {
          await sendDirectReply(chatId, messageId, 'Хранилище настроек не подключено.');
          return;
        }
        const rawText = extractText(incoming) ?? '';
        const parsed = parseBotCommand(rawText, botUsername);
        const nextPrompt = parsed?.args ?? '';
        if (nextPrompt.length === 0) {
          await sendDirectReply(chatId, messageId, SECRETARY_SET_PROMPT_USAGE_REPLY);
          return;
        }
        if (nextPrompt.length > SECRETARY_MAX_PROMPT_LENGTH) {
          await sendDirectReply(
            chatId,
            messageId,
            `Промпт слишком длинный (${nextPrompt.length} симв.). Максимум — ${SECRETARY_MAX_PROMPT_LENGTH} символов.`
          );
          return;
        }
        const result = await settingsStore.setSecretaryPrompt(userId, nextPrompt);
        const confirmation =
          result && result.persisted === false
            ? 'Промпт секретаря обновлён временно (в памяти). Выполните `npx tgcloud migrate`, чтобы он сохранялся постоянно.'
            : 'Промпт режима секретаря обновлён и сохранён.';
        await sendDirectReply(chatId, messageId, confirmation);
        return;
      }

      if (decision === TriggerDecision.SECRETARY_RESET_PROMPT) {
        if (!settingsStore) {
          await sendDirectReply(chatId, messageId, 'Хранилище настроек не подключено.');
          return;
        }
        const result = await settingsStore.resetSecretaryPrompt(userId);
        const confirmation =
          result && result.persisted === false
            ? 'Промпт секретаря сброшен на стандартный временно (в памяти). Выполните `npx tgcloud migrate`, чтобы сохранить сброс.'
            : 'Промпт режима секретаря сброшен на стандартный.';
        await sendDirectReply(chatId, messageId, confirmation);
      }
    },
  };
}
