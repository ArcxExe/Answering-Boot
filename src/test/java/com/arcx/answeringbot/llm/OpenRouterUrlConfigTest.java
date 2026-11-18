package com.arcx.answeringbot.llm;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.model.openai.autoconfigure.OpenAiChatProperties;
import org.springframework.ai.retry.autoconfigure.SpringAiRetryProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(properties = {
        "telegram-bot.enabled=false",
        "telegram-bot.token=test-token",
        "spring.ai.openai.api-key=test-openrouter-key",
        "spring.ai.google.genai.api-key=test-gemini-key"
})
class OpenRouterUrlConfigTest {

    @Autowired
    private Environment env;

    @Autowired
    private OpenAiChatProperties openAiChatProperties;

    @Autowired
    private SpringAiRetryProperties retryProperties;

    @Test
    void openRouterBaseUrlIncludesV1AndRetryBudgetsAreBounded() {
        assertThat(env.getProperty("spring.ai.openai.base-url"))
                .isEqualTo("https://openrouter.ai/api/v1");
        assertThat(openAiChatProperties.getMaxRetries()).isLessThanOrEqualTo(1);
        assertThat(retryProperties.getMaxAttempts()).isLessThanOrEqualTo(2);
    }

    @Test
    void openAiClientPostsToChatCompletionsUnderConfiguredV1BaseUrl() throws Exception {
        AtomicReference<String> capturedPath = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/", exchange -> {
            capturedPath.set(exchange.getRequestURI().getPath());
            String responseJson = """
                    {
                      "id": "chatcmpl-test",
                      "object": "chat.completion",
                      "created": 1700000000,
                      "model": "deepseek/deepseek-chat",
                      "choices": [
                        {
                          "index": 0,
                          "message": { "role": "assistant", "content": "ok" },
                          "finish_reason": "stop"
                        }
                      ]
                    }
                    """;
            byte[] bytes = responseJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();

        String configuredBaseUrl = env.getProperty("spring.ai.openai.base-url");
        String suffix = configuredBaseUrl != null && configuredBaseUrl.endsWith("/v1") ? "/api/v1" : "/api";
        int port = server.getAddress().getPort();

        try (ConfigurableApplicationContext ctx = SpringApplication.run(
                com.arcx.answeringbot.AnsweringBotApplication.class,
                "--telegram-bot.enabled=false",
                "--telegram-bot.token=test-token",
                "--spring.main.web-application-type=none",
                "--spring.ai.openai.base-url=http://localhost:" + port + suffix,
                "--spring.ai.openai.api-key=test-openrouter-key",
                "--spring.ai.google.genai.api-key=test-gemini-key"
        )) {
            LlmClient openRouter = ctx.getBean("openRouterLlmClient", LlmClient.class);
            String reply = openRouter.ask(List.of(new UserMessage("ping")));
            assertThat(reply).isEqualTo("ok");
            assertThat(capturedPath.get()).isEqualTo("/api/v1/chat/completions");
        } finally {
            server.stop(0);
        }
    }
}
