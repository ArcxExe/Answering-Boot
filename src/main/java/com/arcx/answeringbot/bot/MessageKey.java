package com.arcx.answeringbot.bot;

/**
 * Unique identifier of a Telegram message within a chat.
 */
public record MessageKey(long chatId, int messageId) {
}
