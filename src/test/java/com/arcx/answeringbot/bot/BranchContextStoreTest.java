package com.arcx.answeringbot.bot;

import com.arcx.answeringbot.config.BotProperties;
import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class BranchContextStoreTest {

    private static BotProperties props(int maxDepth, int maxSize, Duration ttl) {
        return new BotProperties(
                "token",
                true,
                Set.of(),
                "Будь кратким и информативным.",
                maxDepth,
                maxSize,
                ttl
        );
    }

    @Test
    void buildsMultiStepReplyChainFromRootToLeaf() {
        Instant now = Instant.parse("2026-11-18T12:00:00Z");
        Clock clock = Clock.fixed(now, ZoneId.of("UTC"));
        var store = new BranchContextStore(props(20, 100, Duration.ofHours(24)), clock);

        long chatId = -1001L;
        store.recordNode(new BranchNode(
                new MessageKey(chatId, 10),
                null,
                BranchNode.Role.USER,
                "Иван",
                "Канал Codex",
                "Сегодня вышло обновление Codex",
                now
        ));
        store.recordNode(new BranchNode(
                new MessageKey(chatId, 11),
                10,
                BranchNode.Role.USER,
                "Мария",
                null,
                "Когда день рождения у codex?",
                now.plusSeconds(5)
        ));
        store.recordNode(new BranchNode(
                new MessageKey(chatId, 12),
                11,
                BranchNode.Role.ASSISTANT,
                "bot",
                null,
                "Codex впервые представили 10 августа 2021 года.",
                now.plusSeconds(8)
        ));
        store.recordNode(new BranchNode(
                new MessageKey(chatId, 13),
                12,
                BranchNode.Role.USER,
                "Петр",
                null,
                "А когда вышла новая версия?",
                now.plusSeconds(12)
        ));

        List<Message> prompt = store.buildPromptMessages(new MessageKey(chatId, 13));

        assertThat(prompt).hasSize(5);
        assertThat(prompt.get(0)).isInstanceOf(SystemMessage.class);
        assertThat(prompt.get(0).getText()).isEqualTo("Будь кратким и информативным.");

        assertThat(prompt.get(1)).isInstanceOf(UserMessage.class);
        assertThat(prompt.get(1).getText())
                .contains("[Переслано от Канал Codex]")
                .contains("Сегодня вышло обновление Codex");

        assertThat(prompt.get(2)).isInstanceOf(UserMessage.class);
        assertThat(prompt.get(2).getText()).contains("Мария").contains("Когда день рождения у codex?");

        assertThat(prompt.get(3)).isInstanceOf(AssistantMessage.class);
        assertThat(prompt.get(3).getText()).isEqualTo("Codex впервые представили 10 августа 2021 года.");

        assertThat(prompt.get(4)).isInstanceOf(UserMessage.class);
        assertThat(prompt.get(4).getText()).contains("Петр").contains("А когда вышла новая версия?");
    }

    @Test
    void respectsMaxDepthLimitAndAvoidsCycles() {
        Instant now = Instant.parse("2026-11-18T12:00:00Z");
        Clock clock = Clock.fixed(now, ZoneId.of("UTC"));
        var store = new BranchContextStore(props(3, 100, Duration.ofHours(24)), clock);

        long chatId = -1002L;
        for (int i = 1; i <= 10; i++) {
            Integer parent = (i == 1) ? 10 : i - 1; // intentional cycle on node 1 -> 10
            store.recordNode(new BranchNode(
                    new MessageKey(chatId, i),
                    parent,
                    BranchNode.Role.USER,
                    "User",
                    null,
                    "msg-" + i,
                    now.plusSeconds(i)
            ));
        }

        List<Message> prompt = store.buildPromptMessages(new MessageKey(chatId, 10));

        assertThat(prompt).hasSize(4); // SystemMessage + 3 deepest messages
        assertThat(prompt.get(1).getText()).contains("msg-8");
        assertThat(prompt.get(2).getText()).contains("msg-9");
        assertThat(prompt.get(3).getText()).contains("msg-10");
    }

    @Test
    void evictsExpiredAndOverflowEntries() {
        var currentTime = new AtomicReference<>(Instant.parse("2026-11-18T12:00:00Z"));
        Clock mutableClock = new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneId.of("UTC");
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return currentTime.get();
            }
        };

        var store = new BranchContextStore(props(20, 2, Duration.ofMinutes(10)), mutableClock);
        long chatId = -1003L;

        store.recordNode(new BranchNode(new MessageKey(chatId, 1), null, BranchNode.Role.USER, "U1", null, "one", currentTime.get()));
        store.recordNode(new BranchNode(new MessageKey(chatId, 2), null, BranchNode.Role.USER, "U2", null, "two", currentTime.get()));
        store.recordNode(new BranchNode(new MessageKey(chatId, 3), null, BranchNode.Role.USER, "U3", null, "three", currentTime.get()));

        // Max size 2 evicted key 1
        assertThat(store.contains(new MessageKey(chatId, 1))).isFalse();
        assertThat(store.contains(new MessageKey(chatId, 2))).isTrue();
        assertThat(store.contains(new MessageKey(chatId, 3))).isTrue();

        // Advance time beyond 10m TTL -> entries 2 and 3 expire
        currentTime.set(currentTime.get().plus(Duration.ofMinutes(11)));
        assertThat(store.contains(new MessageKey(chatId, 2))).isFalse();
        assertThat(store.contains(new MessageKey(chatId, 3))).isFalse();
    }
}
