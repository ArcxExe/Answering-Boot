package com.arcx.answeringbot.bot;

import com.arcx.answeringbot.config.BotProperties;
import com.arcx.answeringbot.llm.LlmFallbackService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.telegram.telegrambots.meta.api.methods.botapimethods.BotApiMethod;
import org.telegram.telegrambots.meta.api.methods.send.SendChatAction;
import org.telegram.telegrambots.meta.api.methods.send.SendMessage;
import org.telegram.telegrambots.meta.api.objects.MessageEntity;
import org.telegram.telegrambots.meta.api.objects.User;
import org.telegram.telegrambots.meta.api.objects.chat.Chat;
import org.telegram.telegrambots.meta.api.objects.message.Message;
import org.telegram.telegrambots.meta.api.objects.messageorigin.MessageOriginChannel;
import org.telegram.telegrambots.meta.generics.TelegramClient;

import java.time.Duration;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TelegramBotServiceTest {

    private static final long BOT_ID = 999L;
    private static final String BOT_USERNAME = "answering_bot";

    private static BotProperties defaultProps() {
        return new BotProperties(
                "token",
                true,
                Set.of(),
                "Будь кратким.",
                20,
                1000,
                Duration.ofHours(24)
        );
    }

    private static TelegramBotService createService(
            TelegramClient telegramClient,
            LlmFallbackService llmService,
            BranchContextStore store
    ) {
        var props = defaultProps();
        var extractor = new TelegramMessageExtractor();
        var evaluator = new UpdateTriggerEvaluator(props, extractor);
        return new TelegramBotService(
                props,
                store,
                extractor,
                evaluator,
                llmService,
                telegramClient,
                BOT_ID,
                BOT_USERNAME
        );
    }

    @Test
    void answersForwardedReplyMentionAndStoresBotReply() throws Exception {
        TelegramClient telegramClient = mock(TelegramClient.class);
        LlmFallbackService llmService = mock(LlmFallbackService.class);
        BranchContextStore store = new BranchContextStore(defaultProps());
        TelegramBotService botService = createService(telegramClient, llmService, store);

        Chat group = Chat.builder().id(-100500L).type("supergroup").title("DevChat").build();
        Message forwardedPost = Message.builder()
                .messageId(50)
                .chat(group)
                .from(User.builder().id(10L).firstName("Алексей").isBot(false).build())
                .forwardOrigin(MessageOriginChannel.builder()
                        .chat(Chat.builder().id(-200L).type("channel").title("OpenAI News").build())
                        .build())
                .text("Сегодня релиз Codex...")
                .build();

        Message incoming = Message.builder()
                .messageId(51)
                .chat(group)
                .from(User.builder().id(11L).firstName("Мария").isBot(false).build())
                .replyToMessage(forwardedPost)
                .text("@answering_bot когда день рождения у codex")
                .entities(List.of(MessageEntity.builder().type("mention").offset(0).length(14).build()))
                .build();

        when(llmService.generateAnswer(any())).thenReturn("10 августа 2021 года.");
        when(telegramClient.execute(any(SendChatAction.class))).thenReturn(Boolean.TRUE);
        Message sentBotMsg = Message.builder()
                .messageId(52)
                .chat(group)
                .from(User.builder().id(BOT_ID).firstName("Bot").isBot(true).build())
                .text("10 августа 2021 года.")
                .build();
        when(telegramClient.execute(any(SendMessage.class))).thenReturn(sentBotMsg);

        botService.processMessage(incoming);

        ArgumentCaptor<List<org.springframework.ai.chat.messages.Message>> llmCaptor = ArgumentCaptor.forClass(List.class);
        verify(llmService).generateAnswer(llmCaptor.capture());
        List<org.springframework.ai.chat.messages.Message> sentToLlm = llmCaptor.getValue();
        assertThat(sentToLlm).hasSize(3);
        assertThat(sentToLlm.get(0)).isInstanceOf(SystemMessage.class);
        assertThat(sentToLlm.get(1)).isInstanceOf(UserMessage.class);
        assertThat(sentToLlm.get(1).getText()).contains("OpenAI News").contains("Сегодня релиз Codex...");
        assertThat(sentToLlm.get(2)).isInstanceOf(UserMessage.class);
        assertThat(sentToLlm.get(2).getText()).contains("когда день рождения у codex").doesNotContain("@answering_bot");

        ArgumentCaptor<BotApiMethod> methodCaptor = ArgumentCaptor.forClass(BotApiMethod.class);
        verify(telegramClient, org.mockito.Mockito.times(2)).execute(methodCaptor.capture());
        assertThat(methodCaptor.getAllValues().get(0)).isInstanceOf(SendChatAction.class);
        SendMessage sent = (SendMessage) methodCaptor.getAllValues().get(1);
        assertThat(sent.getChatId()).isEqualTo("-100500");
        assertThat(sent.getReplyToMessageId()).isEqualTo(51);
        assertThat(sent.getText()).isEqualTo("10 августа 2021 года.");

        assertThat(store.contains(new MessageKey(-100500L, 52))).isTrue();
        var nextTurnPrompt = store.buildPromptMessages(new MessageKey(-100500L, 52));
        assertThat(nextTurnPrompt.getLast()).isInstanceOf(AssistantMessage.class);
        assertThat(nextTurnPrompt.getLast().getText()).isEqualTo("10 августа 2021 года.");
    }

    @Test
    void usesDefaultPromptWhenUserOnlyMentionsBotOnForwardedReply() throws Exception {
        TelegramClient telegramClient = mock(TelegramClient.class);
        LlmFallbackService llmService = mock(LlmFallbackService.class);
        BranchContextStore store = new BranchContextStore(defaultProps());
        TelegramBotService botService = createService(telegramClient, llmService, store);

        Chat group = Chat.builder().id(-100L).type("group").build();
        Message forwarded = Message.builder()
                .messageId(10)
                .chat(group)
                .caption("Важный анонс про Java 25")
                .build();
        Message mentionOnly = Message.builder()
                .messageId(11)
                .chat(group)
                .from(User.builder().id(11L).firstName("Иван").isBot(false).build())
                .replyToMessage(forwarded)
                .text("@answering_bot")
                .build();

        when(llmService.generateAnswer(any())).thenReturn("Краткое пояснение.");
        when(telegramClient.execute(any(SendChatAction.class))).thenReturn(Boolean.TRUE);
        when(telegramClient.execute(any(SendMessage.class)))
                .thenReturn(Message.builder().messageId(12).chat(group).text("Краткое пояснение.").build());

        botService.processMessage(mentionOnly);

        ArgumentCaptor<List<org.springframework.ai.chat.messages.Message>> llmCaptor = ArgumentCaptor.forClass(List.class);
        verify(llmService).generateAnswer(llmCaptor.capture());
        assertThat(llmCaptor.getValue().getLast().getText())
                .contains("Дай краткий и информативный ответ");
    }

    @Test
    void handlesDmStartWithoutCallingLlm() throws Exception {
        TelegramClient telegramClient = mock(TelegramClient.class);
        LlmFallbackService llmService = mock(LlmFallbackService.class);
        BranchContextStore store = new BranchContextStore(defaultProps());
        TelegramBotService botService = createService(telegramClient, llmService, store);

        Chat dm = Chat.builder().id(777L).type("private").build();
        Message startMsg = Message.builder()
                .messageId(1)
                .chat(dm)
                .from(User.builder().id(777L).firstName("Иван").isBot(false).build())
                .text("/start")
                .build();

        when(telegramClient.execute(any(SendMessage.class)))
                .thenReturn(Message.builder().messageId(2).chat(dm).text("Привет").build());

        botService.processMessage(startMsg);

        verify(llmService, never()).generateAnswer(any());
        ArgumentCaptor<SendMessage> sendCaptor = ArgumentCaptor.forClass(SendMessage.class);
        verify(telegramClient).execute(sendCaptor.capture());
        assertThat(sendCaptor.getValue().getChatId()).isEqualTo("777");
        assertThat(sendCaptor.getValue().getText()).contains("@" + BOT_USERNAME);
    }

    @Test
    void sendsSafeFallbackMessageWhenBothLlmProvidersFail() throws Exception {
        TelegramClient telegramClient = mock(TelegramClient.class);
        LlmFallbackService llmService = mock(LlmFallbackService.class);
        BranchContextStore store = new BranchContextStore(defaultProps());
        TelegramBotService botService = createService(telegramClient, llmService, store);

        Chat group = Chat.builder().id(-100L).type("group").build();
        Message incoming = Message.builder()
                .messageId(20)
                .chat(group)
                .from(User.builder().id(11L).firstName("Иван").isBot(false).build())
                .text("@answering_bot привет")
                .build();

        when(telegramClient.execute(any(SendChatAction.class))).thenReturn(Boolean.TRUE);
        when(llmService.generateAnswer(any())).thenThrow(new IllegalStateException("Both failed"));
        when(telegramClient.execute(any(SendMessage.class)))
                .thenReturn(Message.builder().messageId(21).chat(group).text("err").build());

        botService.processMessage(incoming);

        ArgumentCaptor<SendMessage> sendCaptor = ArgumentCaptor.forClass(SendMessage.class);
        verify(telegramClient).execute(sendCaptor.capture());
        assertThat(sendCaptor.getValue().getReplyToMessageId()).isEqualTo(20);
        assertThat(sendCaptor.getValue().getText()).contains("Не удалось получить ответ");
    }
}
