package com.arcx.answeringbot.bot;

import com.arcx.answeringbot.config.BotProperties;
import com.arcx.answeringbot.llm.LlmFallbackService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Service;
import org.telegram.telegrambots.client.okhttp.OkHttpTelegramClient;
import org.telegram.telegrambots.longpolling.TelegramBotsLongPollingApplication;
import org.telegram.telegrambots.longpolling.util.LongPollingSingleThreadUpdateConsumer;
import org.telegram.telegrambots.meta.api.methods.ActionType;
import org.telegram.telegrambots.meta.api.methods.GetMe;
import org.telegram.telegrambots.meta.api.methods.send.SendChatAction;
import org.telegram.telegrambots.meta.api.methods.send.SendMessage;
import org.telegram.telegrambots.meta.api.objects.Update;
import org.telegram.telegrambots.meta.api.objects.User;
import org.telegram.telegrambots.meta.api.objects.message.Message;
import org.telegram.telegrambots.meta.exceptions.TelegramApiException;
import org.telegram.telegrambots.meta.generics.TelegramClient;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Long-polling Telegram bot service handling group @mentions and reply-branch Q&A.
 */
@Service
public class TelegramBotService implements SmartLifecycle, LongPollingSingleThreadUpdateConsumer {

    private static final Logger log = LoggerFactory.getLogger(TelegramBotService.class);
    private static final int TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
    private static final String DEFAULT_FORWARD_PROMPT =
            "Дай краткий и информативный ответ или пояснение по этому сообщению.";
    private static final String LLM_ERROR_REPLY =
            "Не удалось получить ответ от нейросети. Попробуйте чуть позже.";

    private final BotProperties properties;
    private final BranchContextStore contextStore;
    private final TelegramMessageExtractor extractor;
    private final UpdateTriggerEvaluator triggerEvaluator;
    private final LlmFallbackService llmService;

    private volatile TelegramClient telegramClient;
    private volatile long botId;
    private volatile String botUsername;
    private volatile boolean running;

    private TelegramBotsLongPollingApplication longPollingApp;
    private ExecutorService executorService;

    @Autowired
    public TelegramBotService(
            BotProperties properties,
            BranchContextStore contextStore,
            TelegramMessageExtractor extractor,
            UpdateTriggerEvaluator triggerEvaluator,
            LlmFallbackService llmService
    ) {
        this.properties = properties;
        this.contextStore = contextStore;
        this.extractor = extractor;
        this.triggerEvaluator = triggerEvaluator;
        this.llmService = llmService;
    }

    TelegramBotService(
            BotProperties properties,
            BranchContextStore contextStore,
            TelegramMessageExtractor extractor,
            UpdateTriggerEvaluator triggerEvaluator,
            LlmFallbackService llmService,
            TelegramClient telegramClient,
            long botId,
            String botUsername
    ) {
        this(properties, contextStore, extractor, triggerEvaluator, llmService);
        this.telegramClient = telegramClient;
        this.botId = botId;
        this.botUsername = botUsername;
    }

    @Override
    public synchronized void start() {
        if (running || !properties.enabled()) {
            return;
        }
        if (properties.token() == null || properties.token().isBlank()) {
            throw new IllegalStateException("telegram-bot.token must be configured when telegram-bot.enabled=true");
        }
        try {
            this.telegramClient = new OkHttpTelegramClient(properties.token());
            User me = telegramClient.execute(GetMe.builder().build());
            this.botId = me.getId();
            this.botUsername = me.getUserName() != null ? me.getUserName() : "";
            this.executorService = Executors.newVirtualThreadPerTaskExecutor();
            this.longPollingApp = new TelegramBotsLongPollingApplication();
            this.longPollingApp.registerBot(properties.token(), this);
            this.running = true;
            log.info("Telegram bot @{} (id={}) started with long polling", botUsername, botId);
        } catch (TelegramApiException ex) {
            throw new IllegalStateException("Failed to start Telegram bot", ex);
        }
    }

    @Override
    public synchronized void stop() {
        if (!running) {
            return;
        }
        running = false;
        if (longPollingApp != null) {
            try {
                longPollingApp.close();
            } catch (Exception ex) {
                log.warn("Error closing Telegram long polling application", ex);
            }
        }
        if (executorService != null) {
            executorService.shutdown();
        }
        log.info("Telegram bot @{} stopped", botUsername);
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public void consume(Update update) {
        if (update == null || !update.hasMessage()) {
            return;
        }
        Message message = update.getMessage();
        if (executorService != null) {
            executorService.execute(() -> processMessageSafely(message));
        } else {
            processMessageSafely(message);
        }
    }

    private void processMessageSafely(Message message) {
        try {
            processMessage(message);
        } catch (RuntimeException ex) {
            log.error("Unhandled error while processing message {} in chat {}",
                    message.getMessageId(), message.getChatId(), ex);
        }
    }

    void processMessage(Message incoming) {
        UpdateTriggerEvaluator.TriggerDecision decision = triggerEvaluator.evaluate(incoming, botId, botUsername);
        if (decision == UpdateTriggerEvaluator.TriggerDecision.IGNORE) {
            return;
        }

        long chatId = incoming.getChatId();
        if (decision == UpdateTriggerEvaluator.TriggerDecision.PRIVATE_START) {
            sendReply(chatId, incoming.getMessageId(), buildStartGreeting());
            return;
        }

        Message replyTo = incoming.getReplyToMessage();
        seedReplyParentIfMissing(chatId, replyTo);

        String rawText = extractor.extractText(incoming).orElse("");
        String cleanQuery = extractor.stripBotMention(rawText, botUsername);
        if (cleanQuery.isBlank()) {
            if (replyTo == null) {
                return;
            }
            cleanQuery = DEFAULT_FORWARD_PROMPT;
        }

        MessageKey incomingKey = new MessageKey(chatId, incoming.getMessageId());
        Integer parentId = replyTo != null ? replyTo.getMessageId() : null;
        contextStore.recordNode(new BranchNode(
                incomingKey,
                parentId,
                BranchNode.Role.USER,
                extractor.extractAuthorLabel(incoming),
                extractor.extractForwardedFrom(incoming).orElse(null),
                cleanQuery,
                Instant.now()
        ));

        sendTyping(chatId);

        String answer;
        try {
            var promptMessages = contextStore.buildPromptMessages(incomingKey);
            answer = llmService.generateAnswer(promptMessages);
        } catch (RuntimeException ex) {
            log.error("LLM generation failed for chat {} message {}", chatId, incoming.getMessageId(), ex);
            sendReply(chatId, incoming.getMessageId(), LLM_ERROR_REPLY);
            return;
        }

        List<String> chunks = extractor.splitForTelegram(answer, TELEGRAM_MAX_MESSAGE_LENGTH);
        Integer replyTargetId = incoming.getMessageId();
        for (String chunk : chunks) {
            Message sent = sendReply(chatId, replyTargetId, chunk);
            if (sent != null) {
                contextStore.recordNode(new BranchNode(
                        new MessageKey(chatId, sent.getMessageId()),
                        replyTargetId,
                        BranchNode.Role.ASSISTANT,
                        botUsername,
                        null,
                        chunk,
                        Instant.now()
                ));
                replyTargetId = sent.getMessageId();
            }
        }
    }

    private void seedReplyParentIfMissing(long chatId, Message replyTo) {
        if (replyTo == null || replyTo.getMessageId() == null) {
            return;
        }
        MessageKey replyKey = new MessageKey(chatId, replyTo.getMessageId());
        if (contextStore.contains(replyKey)) {
            return;
        }
        extractor.extractText(replyTo).ifPresent(text -> {
            BranchNode.Role role = replyTo.getFrom() != null && replyTo.getFrom().getId().equals(botId)
                    ? BranchNode.Role.ASSISTANT
                    : BranchNode.Role.USER;
            contextStore.recordNode(new BranchNode(
                    replyKey,
                    null,
                    role,
                    extractor.extractAuthorLabel(replyTo),
                    extractor.extractForwardedFrom(replyTo).orElse(null),
                    text,
                    Instant.now()
            ));
        });
    }

    private void sendTyping(long chatId) {
        try {
            telegramClient.execute(SendChatAction.builder()
                    .chatId(chatId)
                    .action(ActionType.TYPING.toString())
                    .build());
        } catch (TelegramApiException ex) {
            log.debug("Failed to send typing action to chat {}", chatId, ex);
        }
    }

    private Message sendReply(long chatId, Integer replyToMessageId, String text) {
        try {
            return telegramClient.execute(SendMessage.builder()
                    .chatId(chatId)
                    .replyToMessageId(replyToMessageId)
                    .text(text)
                    .build());
        } catch (TelegramApiException ex) {
            log.error("Failed to send Telegram reply in chat {}", chatId, ex);
            return null;
        }
    }

    private String buildStartGreeting() {
        String handle = (botUsername != null && !botUsername.isBlank()) ? "@" + botUsername : "меня";
        return "Привет! Добавьте меня в группу и отвечайте на пересланные или обычные сообщения с упоминанием "
                + handle + " — я отвечу кратко и по делу.";
    }
}
