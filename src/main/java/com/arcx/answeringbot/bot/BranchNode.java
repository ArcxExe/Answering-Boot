package com.arcx.answeringbot.bot;

import java.time.Instant;

/**
 * Single message node in a Telegram reply branch.
 */
public record BranchNode(
        MessageKey key,
        Integer parentMessageId,
        Role role,
        String authorLabel,
        String forwardedFrom,
        String text,
        Instant createdAt
) {
    public enum Role {
        USER,
        ASSISTANT
    }
}
