package com.arcx.answeringbot.bot;

import org.junit.jupiter.api.Test;
import org.telegram.telegrambots.meta.api.objects.User;
import org.telegram.telegrambots.meta.api.objects.chat.Chat;
import org.telegram.telegrambots.meta.api.objects.message.Message;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginChannel;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginHiddenUser;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginUser;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class TelegramMessageExtractorTest {

    private final TelegramMessageExtractor extractor = new TelegramMessageExtractor();

    @Test
    void extractsCaptionWhenTextIsNull() {
        Message message = Message.builder()
                .messageId(1)
                .chat(Chat.builder().id(-100L).type("supergroup").build())
                .caption("Пост про Codex")
                .build();

        assertThat(extractor.extractText(message)).contains("Пост про Codex");
    }

    @Test
    void extractsForwardOriginForUserChannelAndHiddenUser() {
        Message fromUser = Message.builder()
                .messageId(1)
                .chat(Chat.builder().id(-100L).type("supergroup").build())
                .forwardOrigin(MessageOriginUser.builder()
                        .senderUser(User.builder().id(42L).firstName("Алексей").lastName("Петров").isBot(false).build())
                        .build())
                .build();

        Message fromChannel = Message.builder()
                .messageId(2)
                .chat(Chat.builder().id(-100L).type("supergroup").build())
                .forwardOrigin(MessageOriginChannel.builder()
                        .chat(Chat.builder().id(-200L).type("channel").title("Новости AI").build())
                        .build())
                .build();

        Message fromHidden = Message.builder()
                .messageId(3)
                .chat(Chat.builder().id(-100L).type("supergroup").build())
                .forwardOrigin(MessageOriginHiddenUser.builder()
                        .senderUserName("Скрытый автор")
                        .build())
                .build();

        assertThat(extractor.extractForwardedFrom(fromUser)).contains("Алексей Петров");
        assertThat(extractor.extractForwardedFrom(fromChannel)).contains("Новости AI");
        assertThat(extractor.extractForwardedFrom(fromHidden)).contains("Скрытый автор");
    }

    @Test
    void stripsBotMentionCaseInsensitively() {
        String stripped = extractor.stripBotMention("@My_Bot когда день рождения?", "my_bot");
        assertThat(stripped).isEqualTo("когда день рождения?");

        String onlyMention = extractor.stripBotMention("  @MY_BOT  ", "my_bot");
        assertThat(onlyMention).isEmpty();
    }

    @Test
    void splitsLongReplyWithin4096Limit() {
        String unit = "Слово ".repeat(20) + "\n";
        String longText = unit.repeat(90); // > 9000 chars

        List<String> parts = extractor.splitForTelegram(longText, 4096);

        assertThat(parts).hasSizeGreaterThan(1);
        assertThat(parts).allSatisfy(part -> assertThat(part.length()).isLessThanOrEqualTo(4096));
        assertThat(String.join("\n", parts).replaceAll("\\s+", " ").trim())
                .isEqualTo(longText.replaceAll("\\s+", " ").trim());
    }
}
