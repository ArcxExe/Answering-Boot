package com.arcx.answeringbot.llm;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.messages.Message;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Sends prompts to OpenRouter first and falls back to Gemini on errors or blank replies.
 */
@Service
public class LlmFallbackService {

    private static final Logger log = LoggerFactory.getLogger(LlmFallbackService.class);

    private final LlmClient primaryClient;
    private final LlmClient fallbackClient;

    public LlmFallbackService(
            @Qualifier("openRouterLlmClient") LlmClient primaryClient,
            @Qualifier("geminiLlmClient") LlmClient fallbackClient
    ) {
        this.primaryClient = primaryClient;
        this.fallbackClient = fallbackClient;
    }

    public String generateAnswer(List<Message> messages) {
        if (messages == null || messages.isEmpty()) {
            throw new IllegalArgumentException("Messages list must not be empty");
        }

        try {
            String primaryAnswer = primaryClient.ask(messages);
            if (primaryAnswer != null && !primaryAnswer.isBlank()) {
                return primaryAnswer.trim();
            }
            log.warn("Primary LLM (OpenRouter) returned empty response, switching to Gemini fallback");
        } catch (RuntimeException ex) {
            log.warn("Primary LLM (OpenRouter) failed ({}), switching to Gemini fallback", ex.getMessage());
        }

        try {
            String fallbackAnswer = fallbackClient.ask(messages);
            if (fallbackAnswer != null && !fallbackAnswer.isBlank()) {
                return fallbackAnswer.trim();
            }
            throw new IllegalStateException("Fallback LLM (Gemini) returned empty response");
        } catch (RuntimeException ex) {
            if (ex instanceof IllegalStateException ise) {
                throw ise;
            }
            throw new IllegalStateException("Both OpenRouter and Gemini LLM providers failed", ex);
        }
    }
}
