package com.arcx.answeringbot.bot;

import org.springframework.stereotype.Component;
import org.telegram.telegrambots.meta.api.objects.MessageEntity;
import org.telegram.telegrambots.meta.api.objects.User;
import org.telegram.telegrambots.meta.api.objects.chat.Chat;
import org.telegram.telegrambots.meta.api.objects.message.Message;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOrigin;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginChannel;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginChat;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginHiddenUser;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginUser;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Pure helper methods for reading text, forward origin, mentions, and splitting replies for Telegram.
 */
@Component
public class TelegramMessageExtractor {

    public Optional<String> extractText(Message message) {
        if (message == null) {
            return Optional.empty();
        }
        String raw = message.getText() != null ? message.getText() : message.getCaption();
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(raw.trim());
    }

    public String extractAuthorLabel(Message message) {
        if (message == null || message.getFrom() == null) {
            return "Пользователь";
        }
        return formatUser(message.getFrom());
    }

    public Optional<String> extractForwardedFrom(Message message) {
        if (message == null) {
            return Optional.empty();
        }
        MessageOrigin origin = message.getForwardOrigin();
        if (origin != null) {
            return switch (origin) {
                case MessageOriginUser userOrigin ->
                        Optional.ofNullable(userOrigin.getSenderUser()).map(this::formatUser);
                case MessageOriginChannel channelOrigin ->
                        Optional.ofNullable(channelOrigin.getChat()).map(this::formatChat);
                case MessageOriginChat chatOrigin ->
                        Optional.ofNullable(chatOrigin.getSenderChat()).map(this::formatChat);
                case MessageOriginHiddenUser hiddenOrigin ->
                        Optional.ofNullable(hiddenOrigin.getSenderUserName()).filter(s -> !s.isBlank());
                default -> Optional.empty();
            };
        }
        if (message.getForwardFromChat() != null) {
            return Optional.of(formatChat(message.getForwardFromChat()));
        }
        if (message.getForwardFrom() != null) {
            return Optional.of(formatUser(message.getForwardFrom()));
        }
        return Optional.empty();
    }

    public boolean hasBotMention(Message message, long botId, String botUsername) {
        if (message == null) {
            return false;
        }
        if (matchesMentionEntities(message.getText(), message.getEntities(), botId, botUsername)) {
            return true;
        }
        if (matchesMentionEntities(message.getCaption(), message.getCaptionEntities(), botId, botUsername)) {
            return true;
        }
        if (botUsername == null || botUsername.isBlank()) {
            return false;
        }
        Pattern mentionPattern = Pattern.compile("(?i)(?<!\\S)@" + Pattern.quote(botUsername) + "(?![A-Za-z0-9_])");
        return extractText(message)
                .map(text -> mentionPattern.matcher(text).find())
                .orElse(false);
    }

    public String stripBotMention(String text, String botUsername) {
        if (text == null || text.isBlank()) {
            return "";
        }
        if (botUsername == null || botUsername.isBlank()) {
            return text.trim();
        }
        String pattern = "(?i)(?<!\\S)@" + Pattern.quote(botUsername) + "(?![A-Za-z0-9_])";
        return text.replaceAll(pattern, "")
                .replaceAll("[ \\t]{2,}", " ")
                .trim();
    }

    public List<String> splitForTelegram(String text, int maxLength) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        if (maxLength <= 0) {
            throw new IllegalArgumentException("maxLength must be positive");
        }
        String remaining = text.trim();
        if (remaining.length() <= maxLength) {
            return List.of(remaining);
        }

        List<String> chunks = new ArrayList<>();
        while (remaining.length() > maxLength) {
            int splitAt = findSplitIndex(remaining, maxLength);
            String chunk = remaining.substring(0, splitAt).trim();
            if (!chunk.isEmpty()) {
                chunks.add(chunk);
            }
            remaining = remaining.substring(splitAt).trim();
        }
        if (!remaining.isEmpty()) {
            chunks.add(remaining);
        }
        return List.copyOf(chunks);
    }

    private int findSplitIndex(String text, int maxLength) {
        int newline = text.lastIndexOf('\n', maxLength);
        if (newline > maxLength / 2) {
            return newline;
        }
        int space = text.lastIndexOf(' ', maxLength);
        if (space > maxLength / 2) {
            return space;
        }
        return maxLength;
    }

    private boolean matchesMentionEntities(
            String content,
            List<MessageEntity> entities,
            long botId,
            String botUsername
    ) {
        if (entities == null || entities.isEmpty()) {
            return false;
        }
        String expectedMention = botUsername != null && !botUsername.isBlank() ? "@" + botUsername : null;
        for (MessageEntity entity : entities) {
            if ("text_mention".equals(entity.getType())
                    && entity.getUser() != null
                    && Objects.equals(entity.getUser().getId(), botId)) {
                return true;
            }
            if ("mention".equals(entity.getType()) && expectedMention != null) {
                String slice = extractEntitySlice(content, entity);
                if (expectedMention.equalsIgnoreCase(slice)) {
                    return true;
                }
            }
        }
        return false;
    }

    private String extractEntitySlice(String content, MessageEntity entity) {
        if (entity.getText() != null) {
            return entity.getText();
        }
        if (content == null || entity.getOffset() == null || entity.getLength() == null) {
            return "";
        }
        int start = entity.getOffset();
        int end = Math.min(content.length(), start + entity.getLength());
        if (start < 0 || start >= end) {
            return "";
        }
        return content.substring(start, end);
    }

    private String formatUser(User user) {
        String first = user.getFirstName() != null ? user.getFirstName().trim() : "";
        String last = user.getLastName() != null ? user.getLastName().trim() : "";
        String fullName = (first + " " + last).trim();
        if (!fullName.isEmpty()) {
            return fullName;
        }
        if (user.getUserName() != null && !user.getUserName().isBlank()) {
            return "@" + user.getUserName().trim();
        }
        return "Пользователь";
    }

    private String formatChat(Chat chat) {
        if (chat.getTitle() != null && !chat.getTitle().isBlank()) {
            return chat.getTitle().trim();
        }
        if (chat.getUserName() != null && !chat.getUserName().isBlank()) {
            return "@" + chat.getUserName().trim();
        }
        return "Чат";
    }
}
