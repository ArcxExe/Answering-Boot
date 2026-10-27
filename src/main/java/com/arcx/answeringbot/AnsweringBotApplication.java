package com.arcx.answeringbot;

import com.arcx.answeringbot.gemini.service.GeminiService;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AnsweringBotApplication {

	public static void main(String[] args) {
		var context = SpringApplication.run(AnsweringBotApplication.class, args);
		GeminiService geminiService = context.getBean(GeminiService.class);

		System.out.println(geminiService.ask("Привет"));
	}

}
