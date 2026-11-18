package com.arcx.answeringbot;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = {
		"telegram-bot.enabled=false",
		"telegram-bot.token=test-token",
		"spring.ai.openai.api-key=test-openrouter-key",
		"spring.ai.google.genai.api-key=test-gemini-key"
})
class AnsweringBotApplicationTests {

	@Test
	void contextLoads() {
	}

}
