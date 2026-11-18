package com.arcx.answeringbot.llm;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.google.genai.GoogleGenAiChatModel;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires separate Spring AI clients for OpenRouter (primary) and Gemini (fallback).
 */
@Configuration
public class LlmClientConfig {

    @Bean("openRouterLlmClient")
    public LlmClient openRouterLlmClient(OpenAiChatModel openAiChatModel) {
        return wrapChatModel(openAiChatModel);
    }

    @Bean("geminiLlmClient")
    public LlmClient geminiLlmClient(GoogleGenAiChatModel googleGenAiChatModel) {
        return wrapChatModel(googleGenAiChatModel);
    }

    private LlmClient wrapChatModel(ChatModel chatModel) {
        ChatClient client = ChatClient.create(chatModel);
        return messages -> client.prompt()
                .messages(messages)
                .call()
                .content();
    }
}
