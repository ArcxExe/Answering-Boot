package com.arcx.answeringbot.llm;

import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LlmFallbackServiceTest {

    private final List<Message> sampleMessages = List.of(new UserMessage("Когда день рождения у codex?"));

    @Test
    void returnsPrimaryOpenRouterAnswerWhenSuccessful() {
        AtomicBoolean fallbackCalled = new AtomicBoolean(false);
        LlmClient primary = messages -> "Короткий ответ";
        LlmClient fallback = messages -> {
            fallbackCalled.set(true);
            return "Ответ от Gemini";
        };

        var service = new LlmFallbackService(primary, fallback);

        String answer = service.generateAnswer(sampleMessages);

        assertThat(answer).isEqualTo("Короткий ответ");
        assertThat(fallbackCalled).isFalse();
    }

    @Test
    void fallsBackToGeminiWhenPrimaryThrowsException() {
        LlmClient primary = messages -> {
            throw new RuntimeException("429 Too Many Requests");
        };
        LlmClient fallback = messages -> "Ответ от Gemini";

        var service = new LlmFallbackService(primary, fallback);

        String answer = service.generateAnswer(sampleMessages);

        assertThat(answer).isEqualTo("Ответ от Gemini");
    }

    @Test
    void fallsBackToGeminiWhenPrimaryReturnsBlank() {
        LlmClient primary = messages -> "   ";
        LlmClient fallback = messages -> "Ответ от Gemini";

        var service = new LlmFallbackService(primary, fallback);

        String answer = service.generateAnswer(sampleMessages);

        assertThat(answer).isEqualTo("Ответ от Gemini");
    }

    @Test
    void throwsWhenBothProvidersFail() {
        LlmClient primary = messages -> {
            throw new RuntimeException("OpenRouter rate limit");
        };
        LlmClient fallback = messages -> {
            throw new RuntimeException("Gemini unavailable");
        };

        var service = new LlmFallbackService(primary, fallback);

        assertThatThrownBy(() -> service.generateAnswer(sampleMessages))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("LLM");
    }
}
