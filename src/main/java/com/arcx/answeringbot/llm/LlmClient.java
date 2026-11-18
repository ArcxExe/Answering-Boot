package com.arcx.answeringbot.llm;

import org.springframework.ai.chat.messages.Message;

import java.util.List;

/**
 * Minimal abstraction over a Spring AI chat client for provider switching and testing.
 */
@FunctionalInterface
public interface LlmClient {

    String ask(List<Message> messages);
}
