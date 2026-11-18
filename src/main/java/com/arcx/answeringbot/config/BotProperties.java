package com.arcx.answeringbot.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;
import java.util.Set;

/**
 * Configuration properties for Telegram bot behavior and reply-branch context cache.
 */
@ConfigurationProperties(prefix = "telegram-bot")
public record BotProperties(
        String token,
        boolean enabled,
        Set<Long> allowedChatIds,
        String systemPrompt,
        int branchMaxDepth,
        int branchCacheMaxSize,
        Duration branchCacheTtl
) {
    private static final String DEFAULT_SYSTEM_PROMPT =
            "Ты краткий и информативный справочный ассистент в групповом чате Telegram. "
                    + "Отвечай кратко, точно и по существу на языке вопроса пользователя. "
                    + "Если вопрос задан к пересланному или цитируемому сообщению, опирайся на его текст и контекст ветки. "
                    + "Не добавляй лишних вступлений, воды и дисклеймеров.";

    public BotProperties {
        allowedChatIds = allowedChatIds == null ? Set.of() : Set.copyOf(allowedChatIds);
        if (systemPrompt == null || systemPrompt.isBlank()) {
            systemPrompt = DEFAULT_SYSTEM_PROMPT;
        }
        if (branchMaxDepth <= 0) {
            branchMaxDepth = 20;
        }
        if (branchCacheMaxSize <= 0) {
            branchCacheMaxSize = 2000;
        }
        if (branchCacheTtl == null || branchCacheTtl.isNegative() || branchCacheTtl.isZero()) {
            branchCacheTtl = Duration.ofHours(24);
        }
    }
}
