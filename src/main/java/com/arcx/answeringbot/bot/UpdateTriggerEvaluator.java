package com.arcx.answeringbot.bot;

import com.arcx.answeringbot.config.BotProperties;
import org.springframework.stereotype.Component;
import org.telegram.telegrambots.meta.api.objects.User;
import org.telegram.telegrambots.meta.api.objects.chat.Chat;
import org.telegram.telegrambots.meta.api.objects.message.Message;

import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Decides whether an incoming Telegram message should trigger a response.
 */
@Component
public class UpdateTriggerEvaluator {

    public enum TriggerDecision {
        IGNORE,
        PRIVATE_START,
        ANSWER
    }

    private final BotProperties properties;
    private final TelegramMessageExtractor extractor;

    public UpdateTriggerEvaluator(BotProperties properties, TelegramMessageExtractor extractor) {
        this.properties = properties;
        this.extractor = extractor;
    }

    public TriggerDecision evaluate(Message message, long botId, String botUsername) {
        if (message == null || message.getChat() == null) {
            return TriggerDecision.IGNORE;
        }

        User sender = message.getFrom();
        if (sender != null && (Boolean.TRUE.equals(sender.getIsBot()) || Objects.equals(sender.getId(), botId))) {
            return TriggerDecision.IGNORE;
        }

        Optional<String> textOpt = extractor.extractText(message);
        if (textOpt.isEmpty()) {
            return TriggerDecision.IGNORE;
        }

        Set<Long> allowed = properties.allowedChatIds();
        if (!allowed.isEmpty() && !allowed.contains(message.getChatId())) {
            return TriggerDecision.IGNORE;
        }

        Chat chat = message.getChat();
        if (isPrivateChat(message, chat)) {
            if (isStartCommand(textOpt.get(), botUsername)) {
                return TriggerDecision.PRIVATE_START;
            }
            return TriggerDecision.ANSWER;
        }

        if (isGroupChat(message, chat)) {
            boolean mentioned = extractor.hasBotMention(message, botId, botUsername);
            boolean repliedToBot = message.getReplyToMessage() != null
                    && message.getReplyToMessage().getFrom() != null
                    && Objects.equals(message.getReplyToMessage().getFrom().getId(), botId);
            return (mentioned || repliedToBot) ? TriggerDecision.ANSWER : TriggerDecision.IGNORE;
        }

        return TriggerDecision.IGNORE;
    }

    private boolean isPrivateChat(Message message, Chat chat) {
        return Boolean.TRUE.equals(chat.isUserChat())
                || message.isUserMessage()
                || "private".equalsIgnoreCase(chat.getType());
    }

    private boolean isGroupChat(Message message, Chat chat) {
        String type = chat.getType();
        return Boolean.TRUE.equals(chat.isGroupChat())
                || Boolean.TRUE.equals(chat.isSuperGroupChat())
                || message.isGroupMessage()
                || message.isSuperGroupMessage()
                || "group".equalsIgnoreCase(type)
                || "supergroup".equalsIgnoreCase(type);
    }

    private boolean isStartCommand(String text, String botUsername) {
        String firstToken = text.trim().split("\\s+", 2)[0];
        if ("/start".equalsIgnoreCase(firstToken)) {
            return true;
        }
        return botUsername != null
                && !botUsername.isBlank()
                && ("/start@" + botUsername).equalsIgnoreCase(firstToken);
    }
}
