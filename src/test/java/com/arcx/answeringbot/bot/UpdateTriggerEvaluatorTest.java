package com.arcx.answeringbot.bot;

import com.arcx.answeringbot.config.BotProperties;
import org.junit.jupiter.api.Test;
import org.telegram.telegrambots.meta.api.objects.MessageEntity;
import org.telegram.telegrambots.meta.api.objects.User;
import org.telegram.telegrambots.meta.api.objects.chat.Chat;
import org.telegram.telegrambots.meta.api.objects.message.Message;

import java.time.Duration;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class UpdateTriggerEvaluatorTest {

    private static final long BOT_ID = 999L;
    private static final String BOT_USERNAME = "answering_bot";

    private static UpdateTriggerEvaluator evaluator(Set<Long> allowedChatIds) {
        var props = new BotProperties("token", true, allowedChatIds, "system", 20, 1000, Duration.ofHours(1));
        return new UpdateTriggerEvaluator(props, new TelegramMessageExtractor());
    }

    private static User human(long id) {
        return User.builder().id(id).firstName("User").isBot(false).build();
    }

    @Test
    void triggersInGroupOnTextMentionAndCaptionMention() {
        var eval = evaluator(Set.of());
        Chat group = Chat.builder().id(-100L).type("supergroup").build();

        Message textMention = Message.builder()
                .messageId(1)
                .chat(group)
                .from(human(10L))
                .text("@Answering_Bot когда день рождения у codex?")
                .entities(List.of(MessageEntity.builder().type("mention").offset(0).length(14).build()))
                .build();

        Message captionMention = Message.builder()
                .messageId(2)
                .chat(group)
                .from(human(10L))
                .caption("Посмотри @answering_bot")
                .captionEntities(List.of(MessageEntity.builder().type("mention").offset(9).length(14).build()))
                .build();

        assertThat(eval.evaluate(textMention, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.ANSWER);
        assertThat(eval.evaluate(captionMention, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.ANSWER);
    }

    @Test
    void triggersInGroupOnReplyToBotMessageWithoutMention() {
        var eval = evaluator(Set.of());
        Chat group = Chat.builder().id(-100L).type("group").build();

        Message botMessage = Message.builder()
                .messageId(5)
                .chat(group)
                .from(User.builder().id(BOT_ID).firstName("Bot").isBot(true).build())
                .text("Ответ бота")
                .build();

        Message followUp = Message.builder()
                .messageId(6)
                .chat(group)
                .from(human(10L))
                .text("А поподробнее?")
                .replyToMessage(botMessage)
                .build();

        assertThat(eval.evaluate(followUp, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.ANSWER);
    }

    @Test
    void ignoresGroupChatterWithoutMentionOrBotReply() {
        var eval = evaluator(Set.of());
        Chat group = Chat.builder().id(-100L).type("supergroup").build();

        Message normalMessage = Message.builder()
                .messageId(7)
                .chat(group)
                .from(human(10L))
                .text("Привет всем в чате")
                .build();

        Message replyToOtherUser = Message.builder()
                .messageId(8)
                .chat(group)
                .from(human(11L))
                .text("Согласен")
                .replyToMessage(normalMessage)
                .build();

        assertThat(eval.evaluate(normalMessage, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.IGNORE);
        assertThat(eval.evaluate(replyToOtherUser, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.IGNORE);
    }

    @Test
    void ignoresDisallowedChatWhenAllowlistConfigured() {
        var eval = evaluator(Set.of(100L));

        Message disallowed = Message.builder()
                .messageId(1)
                .chat(Chat.builder().id(200L).type("supergroup").build())
                .from(human(10L))
                .text("@answering_bot вопрос")
                .build();

        Message allowed = Message.builder()
                .messageId(2)
                .chat(Chat.builder().id(100L).type("supergroup").build())
                .from(human(10L))
                .text("@answering_bot вопрос")
                .build();

        assertThat(eval.evaluate(disallowed, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.IGNORE);
        assertThat(eval.evaluate(allowed, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.ANSWER);
    }

    @Test
    void returnsPrivateStartOnDmStartCommandAndAnswerOnDmText() {
        var eval = evaluator(Set.of());
        Chat dm = Chat.builder().id(500L).type("private").build();

        Message start = Message.builder()
                .messageId(1)
                .chat(dm)
                .from(human(500L))
                .text("/start")
                .build();

        Message dmQuestion = Message.builder()
                .messageId(2)
                .chat(dm)
                .from(human(500L))
                .text("Что такое Spring AI?")
                .build();

        assertThat(eval.evaluate(start, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.PRIVATE_START);
        assertThat(eval.evaluate(dmQuestion, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.ANSWER);
    }

    @Test
    void ignoresOwnMessagesAndOtherBots() {
        var eval = evaluator(Set.of());
        Chat dm = Chat.builder().id(500L).type("private").build();

        Message selfMessage = Message.builder()
                .messageId(1)
                .chat(dm)
                .from(User.builder().id(BOT_ID).firstName("Bot").isBot(true).build())
                .text("Мой ответ")
                .build();

        Message otherBotMessage = Message.builder()
                .messageId(2)
                .chat(Chat.builder().id(-100L).type("group").build())
                .from(User.builder().id(777L).firstName("OtherBot").isBot(true).build())
                .text("@answering_bot привет")
                .build();

        assertThat(eval.evaluate(selfMessage, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.IGNORE);
        assertThat(eval.evaluate(otherBotMessage, BOT_ID, BOT_USERNAME))
                .isEqualTo(UpdateTriggerEvaluator.TriggerDecision.IGNORE);
    }
}
