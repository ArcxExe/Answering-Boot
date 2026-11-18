# AnsweringBot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Telegram Q&A group bot (`AnsweringBot`) using Spring AI 2.0.0 (OpenRouter primary with automatic Gemini fallback), reply-branch context caching, `telegrambots` 10.3.0 long polling, and a single-command Docker setup.

**Architecture:** Replace the unfinished `RestClient` packages (`gemini/`, `openrouter/`) with Spring AI 2.0.0 (`spring-ai-starter-model-openai` for OpenRouter and `spring-ai-starter-model-google-genai` for Gemini), wired as two explicit `ChatClient`s behind an `LlmFallbackService`. Build a `telegrambots-longpolling` 10.3.0 service that triggers on group `@mention` or reply-to-bot (plus DM `/start` and reply-only turns), reconstructs reply-chain `Message` history via a bounded in-memory `BranchContextStore`, and packages the app with a multi-stage `Dockerfile` and `compose.yaml`.

**Tech Stack:** Java 21, Spring Boot 4.1.2, Gradle, Spring AI 2.0.0 (`spring-ai-bom`), `telegrambots-longpolling:10.3.0`, `telegrambots-client:10.3.0`, JUnit 5, Mockito, Docker / Docker Compose.

**Spec:** [2026-11-18-answering-bot-design.md](file:///home/arcx/code/Project_java/AnsweringBot/docs/superpowers/specs/2026-11-18-answering-bot-design.md)

## Global Constraints

- Java 21, Spring Boot `4.1.2`, Gradle (`build.gradle`).
- Spring AI `2.0.0` (`org.springframework.ai:spring-ai-bom:2.0.0`) from Maven Central; disable auto single-bean `ChatClient.Builder` (`spring.ai.chat.client.enabled: false`).
- Keep existing `.env` variable names verbatim: `TELEGRAM_BOT_API`, `OPENROUTER_API`, `GEMINI_API`.
- Use existing `telegrambots-longpolling:10.3.0` and `telegrambots-client:10.3.0` (`TelegramBotsLongPollingApplication` + `OkHttpTelegramClient`), without adding `telegrambots-springboot-longpolling-starter`.
- Reply-branch context only across all chats (no full-group history, no DB, no sequential DM history or `/new` command).
- Default access is open in any group; optional `allowed-chat-ids` config filters chats only when non-empty.
- Send plain text replies (no fragile MarkdownV2 escaping) and split messages exceeding 4096 characters.
- Docker launch via `docker compose up -d --build` documented in `README.md`.

## Review Focus

- **Empty query after `@botname` stripping on a forwarded reply:** A user replies to a forwarded message with only `@botname`. Must synthesize a concise instruction (e.g., «Дай краткий и информативный ответ или пояснение по этому сообщению.») instead of sending an empty `UserMessage` or ignoring the call. (Tested in Task 4)
- **Media messages with `caption` and `caption_entities`:** A forwarded post or mention is on a photo/video with `text == null` and `caption != null`. Must extract `caption` and `caption_entities` without `NullPointerException`. (Tested in Task 4)
- **LLM response > 4096 chars or blank/both-providers-failed:** Long output must be split into chunks `<= 4096` chars; if both OpenRouter and Gemini fail or return blank text, send a short safe error reply instead of crashing the consumer loop. (Tested in Task 2 and Task 5)
- **Cache miss on `reply_to_message` after restart:** A user replies to an older forwarded message not in memory. Must seed `reply_to_message` (including its `forwardOrigin`) as the root node so the forwarded context is preserved. (Tested in Task 3)
- **Non-mentioned / unauthorized group messages:** Normal group chatter without `@botname` or reply-to-bot (or from a disallowed chat ID when `allowed-chat-ids` is set) must be ignored without invoking any LLM. (Tested in Task 4)

---

### File Map

| File | Responsibility |
|---|---|
| `build.gradle` | Add `spring-ai-bom:2.0.0`, `spring-ai-starter-model-openai`, `spring-ai-starter-model-google-genai`. |
| `src/main/resources/application.yaml` | Configure Spring AI OpenRouter + Gemini, disable `ChatClient.Builder` auto-config, add `telegram-bot.*` properties. |
| `src/main/java/com/arcx/answeringbot/gemini/*` (delete) | Remove obsolete manual `RestClient` Gemini code. |
| `src/main/java/com/arcx/answeringbot/openrouter/*` (delete) | Remove obsolete manual `RestClient` OpenRouter code. |
| `src/main/java/com/arcx/answeringbot/config/BotProperties.java` | `@ConfigurationProperties("telegram-bot")` binding token, enabled flag, `allowedChatIds`, `systemPrompt`, `branchMaxDepth`, `branchCacheMaxSize`, `branchCacheTtl`. |
| `src/main/java/com/arcx/answeringbot/llm/LlmClient.java` | Functional interface `String ask(List<Message> messages)`. |
| `src/main/java/com/arcx/answeringbot/llm/LlmClientConfig.java` | Create `openRouterLlmClient` and `geminiLlmClient` beans from `OpenAiChatModel` and `GoogleGenAiChatModel`. |
| `src/main/java/com/arcx/answeringbot/llm/LlmFallbackService.java` | Call primary (`openRouterLlmClient`), fall back to `geminiLlmClient` on exception or blank response. |
| `src/main/java/com/arcx/answeringbot/bot/MessageKey.java` | Record `(long chatId, int messageId)`. |
| `src/main/java/com/arcx/answeringbot/bot/BranchNode.java` | Record storing node metadata (`key`, `parentMessageId`, `role`, `authorLabel`, `forwardedFrom`, `text`, `createdAt`). |
| `src/main/java/com/arcx/answeringbot/bot/BranchContextStore.java` | Bounded TTL in-memory store for `BranchNode`s and builder for Spring AI `List<Message>`. |
| `src/main/java/com/arcx/answeringbot/bot/TelegramMessageExtractor.java` | Extract text/caption, `MessageOrigin` forwarder label, `@botname` mentions, stripped query text, and 4096-char splitting. |
| `src/main/java/com/arcx/answeringbot/bot/UpdateTriggerEvaluator.java` | Evaluate `allowedChatIds`, `/start` DM, DM turns, group `@mention` and reply-to-bot triggers. |
| `src/main/java/com/arcx/answeringbot/bot/TelegramBotService.java` | Manage `TelegramBotsLongPollingApplication`, `OkHttpTelegramClient`, `getMe()`, async update execution, typing action, reply sending, and storing bot reply nodes. |
| `Dockerfile`, `compose.yaml`, `.dockerignore`, `README.md` | Multi-stage JDK/JRE 21 container build, Compose service reading `.env`, and quick-start command. |

---

### Task 1: Dependencies, Configuration & Cleanup of Old `RestClient` Packages

**Files:**
- Modify: `build.gradle`
- Modify: `src/main/resources/application.yaml`
- Delete: `src/main/java/com/arcx/answeringbot/gemini/` (all files)
- Delete: `src/main/java/com/arcx/answeringbot/openrouter/` (all files)
- Create: `src/main/java/com/arcx/answeringbot/config/BotProperties.java`
- Modify: `src/main/java/com/arcx/answeringbot/AnsweringBotApplication.java`
- Modify: `src/test/java/com/arcx/answeringbot/AnsweringBotApplicationTests.java`

**Interfaces:**
- Produces:
  - `BotProperties` record/class with `token()`, `enabled()`, `allowedChatIds()`, `systemPrompt()`, `branchMaxDepth()`, `branchCacheMaxSize()`, `branchCacheTtl()`
  - `OpenAiChatModel` and `GoogleGenAiChatModel` Spring AI beans auto-configured via `application.yaml`

- [ ] **Step 1: Update `build.gradle` with Spring AI 2.0.0 BOM and model starters**

Add `mavenBom "org.springframework.ai:spring-ai-bom:2.0.0"` under `dependencyManagement` and add `implementation 'org.springframework.ai:spring-ai-starter-model-openai'` and `implementation 'org.springframework.ai:spring-ai-starter-model-google-genai'`. Keep `telegrambots-longpolling:10.3.0` and `telegrambots-client:10.3.0`.

- [ ] **Step 2: Delete obsolete `gemini` and `openrouter` packages**

Remove `src/main/java/com/arcx/answeringbot/gemini/` and `src/main/java/com/arcx/answeringbot/openrouter/`, and remove the unused `import com.arcx.answeringbot.gemini.service.GeminiService;` in `AnsweringBotApplication.java`.

- [ ] **Step 3: Create `BotProperties.java` and enable `@ConfigurationPropertiesScan` on `AnsweringBotApplication`**

```java
@ConfigurationProperties(prefix = "telegram-bot")
public record BotProperties(
        String token,
        boolean enabled,
        Set<Long> allowedChatIds,
        String systemPrompt,
        int branchMaxDepth,
        int branchCacheMaxSize,
        Duration branchCacheTtl
)
```
Provide compact-constructor defaults (`enabled = true` if unset handled via `application.yaml`, `allowedChatIds = Set.of()` when null, `branchMaxDepth = 20`, `branchCacheMaxSize = 2000`, `branchCacheTtl = Duration.ofHours(24)`).

- [ ] **Step 4: Update `src/main/resources/application.yaml`**

Configure:
- `spring.config.import: "optional:file:.env[.properties]"`
- `spring.ai.chat.client.enabled: false`
- `spring.ai.openai.base-url: https://openrouter.ai/api`
- `spring.ai.openai.api-key: ${OPENROUTER_API:}`
- `spring.ai.openai.chat.options.model: ${OPENROUTER_MODEL:deepseek/deepseek-chat}`
- `spring.ai.google.genai.api-key: ${GEMINI_API:}`
- `spring.ai.google.genai.chat.options.model: ${GEMINI_MODEL:gemini-2.5-flash-lite}`
- `telegram-bot.token: ${TELEGRAM_BOT_API:}`
- `telegram-bot.enabled: true`
- `telegram-bot.allowed-chat-ids:` `[]`
- `telegram-bot.branch-max-depth: 20`
- `telegram-bot.branch-cache-max-size: 2000`
- `telegram-bot.branch-cache-ttl: 24h`
- `telegram-bot.system-prompt`: concise Russian/multilingual assistant instruction (answer briefly, factually, directly, on the user's language, using forwarded context when present).

- [ ] **Step 5: Update `AnsweringBotApplicationTests.java` to verify Spring context loads offline**

```java
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
```

- [ ] **Step 6: Run `./gradlew test`**

Run: `./gradlew test --tests com.arcx.answeringbot.AnsweringBotApplicationTests`
Expected: `BUILD SUCCESSFUL` and `contextLoads()` PASS.

- [ ] **Step 7: Commit**

```bash
git add build.gradle src/main/resources/application.yaml src/main/java/com/arcx/answeringbot/AnsweringBotApplication.java src/main/java/com/arcx/answeringbot/config/BotProperties.java src/test/java/com/arcx/answeringbot/AnsweringBotApplicationTests.java
git rm -r src/main/java/com/arcx/answeringbot/gemini src/main/java/com/arcx/answeringbot/openrouter
git commit -m "chore: migrate dependencies to Spring AI 2.0.0 and configure bot properties"
```

---

### Task 2: Spring AI Dual-Client Wiring & `LlmFallbackService`

**Files:**
- Create: `src/main/java/com/arcx/answeringbot/llm/LlmClient.java`
- Create: `src/main/java/com/arcx/answeringbot/llm/LlmClientConfig.java`
- Create: `src/main/java/com/arcx/answeringbot/llm/LlmFallbackService.java`
- Create: `src/test/java/com/arcx/answeringbot/llm/LlmFallbackServiceTest.java`

**Interfaces:**
- Consumes: `org.springframework.ai.chat.model.ChatModel` (`OpenAiChatModel`, `GoogleGenAiChatModel`), `org.springframework.ai.chat.messages.Message`
- Produces: `LlmFallbackService#generateAnswer(List<Message> messages) -> String`

- [ ] **Step 1: Write failing tests in `LlmFallbackServiceTest.java`**

Write unit tests covering:
1. `returnsPrimaryOpenRouterAnswerWhenSuccessful`: primary returns `"Короткий ответ"`, fallback is never called.
2. `fallsBackToGeminiWhenPrimaryThrowsException`: primary throws `RuntimeException("429 Too Many Requests")`, fallback returns `"Ответ от Gemini"`.
3. `fallsBackToGeminiWhenPrimaryReturnsBlank`: primary returns `"   "`, fallback returns `"Ответ от Gemini"`.
4. `throwsWhenBothProvidersFail`: both throw exceptions, `IllegalStateException` (or wrapped exception) is thrown.

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew test --tests com.arcx.answeringbot.llm.LlmFallbackServiceTest`
Expected: FAIL (classes `LlmClient`, `LlmFallbackService` do not exist).

- [ ] **Step 3: Implement `LlmClient`, `LlmClientConfig`, and `LlmFallbackService`**

- `LlmClient`: `@FunctionalInterface public interface LlmClient { String ask(List<Message> messages); }`
- `LlmClientConfig`: defines `@Bean("openRouterLlmClient") LlmClient` wrapping `ChatClient.create(openAiChatModel)` and `@Bean("geminiLlmClient") LlmClient` wrapping `ChatClient.create(googleGenAiChatModel)`. Each calls `.prompt().messages(messages).call().content()`.
- `LlmFallbackService`: injects `@Qualifier("openRouterLlmClient") LlmClient primary` and `@Qualifier("geminiLlmClient") LlmClient fallback`. `generateAnswer(List<Message> messages)` calls `primary`, falls back to `fallback` if `primary` throws any `RuntimeException` or returns `null`/blank, and throws `IllegalStateException` if `fallback` also fails or returns blank.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew test --tests com.arcx.answeringbot.llm.LlmFallbackServiceTest`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/java/com/arcx/answeringbot/llm src/test/java/com/arcx/answeringbot/llm
git commit -m "feat: add Spring AI OpenRouter and Gemini clients with fallback service"
```

---

### Task 3: Reply-Branch Context Store (`BranchContextStore`)

**Files:**
- Create: `src/main/java/com/arcx/answeringbot/bot/MessageKey.java`
- Create: `src/main/java/com/arcx/answeringbot/bot/BranchNode.java`
- Create: `src/main/java/com/arcx/answeringbot/bot/BranchContextStore.java`
- Create: `src/test/java/com/arcx/answeringbot/bot/BranchContextStoreTest.java`

**Interfaces:**
- Consumes: `BotProperties` (`systemPrompt()`, `branchMaxDepth()`, `branchCacheMaxSize()`, `branchCacheTtl()`)
- Produces:
  - `BranchContextStore#recordNode(BranchNode node)`
  - `BranchContextStore#contains(MessageKey key) -> boolean`
  - `BranchContextStore#buildPromptMessages(MessageKey leafKey) -> List<Message>`

- [ ] **Step 1: Write failing tests in `BranchContextStoreTest.java`**

Write unit tests covering:
1. `buildsMultiStepReplyChainFromRootToLeaf`: root forwarded user message (`forwardedFrom = "Канал Codex"`) -> user question -> bot assistant reply -> follow-up user reply; verifies returned `List<Message>` starts with `SystemMessage` followed by chronological `UserMessage`/`AssistantMessage` with `[Переслано от Канал Codex]` marker on forwarded root.
2. `respectsMaxDepthLimitAndAvoidsCycles`: chain of 10 nodes with `branchMaxDepth = 3` keeps only the last 3 nodes (+ `SystemMessage`); self-referencing or cyclic `parentMessageId` terminates cleanly without infinite loop.
3. `evictsExpiredAndOverflowEntries`: entries older than `branchCacheTtl` (using injectable `Clock`) are evicted, and exceeding `branchCacheMaxSize` evicts oldest entries.

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew test --tests com.arcx.answeringbot.bot.BranchContextStoreTest`
Expected: FAIL (classes not found).

- [ ] **Step 3: Implement `MessageKey`, `BranchNode`, and `BranchContextStore`**

- `BranchNode.Role`: `USER`, `ASSISTANT`.
- `BranchContextStore`: thread-safe bounded `Map<MessageKey, BranchNode>` (using synchronized `LinkedHashMap` in access/insertion order or `ConcurrentHashMap` + bounded eviction queue) with injectable `Clock` (default `Clock.systemUTC()`).
- `buildPromptMessages(MessageKey leafKey)`: walks `parentMessageId` upward up to `maxDepth` with a `Set<Integer> visited` cycle guard, reverses into chronological order, formats `USER` nodes (prefixing `authorLabel` and `[Переслано от <forwardedFrom>]: ` when present) into `UserMessage` and `ASSISTANT` nodes into `AssistantMessage`, prepending `SystemMessage(systemPrompt)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew test --tests com.arcx.answeringbot.bot.BranchContextStoreTest`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/java/com/arcx/answeringbot/bot/MessageKey.java src/main/java/com/arcx/answeringbot/bot/BranchNode.java src/main/java/com/arcx/answeringbot/bot/BranchContextStore.java src/test/java/com/arcx/answeringbot/bot/BranchContextStoreTest.java
git commit -m "feat: add bounded reply-branch context cache"
```

---

### Task 4: Telegram Message Extraction & Trigger Evaluation

**Files:**
- Create: `src/main/java/com/arcx/answeringbot/bot/TelegramMessageExtractor.java`
- Create: `src/main/java/com/arcx/answeringbot/bot/UpdateTriggerEvaluator.java`
- Create: `src/test/java/com/arcx/answeringbot/bot/TelegramMessageExtractorTest.java`
- Create: `src/test/java/com/arcx/answeringbot/bot/UpdateTriggerEvaluatorTest.java`

**Interfaces:**
- Consumes: `BotProperties`, `org.telegram.telegrambots.meta.api.objects.message.Message`, `MessageOrigin*`, `MessageEntity`
- Produces:
  - `TelegramMessageExtractor#extractText(Message message) -> Optional<String>`
  - `TelegramMessageExtractor#extractAuthorLabel(Message message) -> String`
  - `TelegramMessageExtractor#extractForwardedFrom(Message message) -> Optional<String>`
  - `TelegramMessageExtractor#stripBotMention(String text, String botUsername) -> String`
  - `TelegramMessageExtractor#splitForTelegram(String text, int maxLength) -> List<String>`
  - `UpdateTriggerEvaluator#evaluate(Message message, long botId, String botUsername) -> TriggerDecision` (`IGNORE`, `PRIVATE_START`, `ANSWER`)

- [ ] **Step 1: Write failing tests in `TelegramMessageExtractorTest.java` and `UpdateTriggerEvaluatorTest.java`**

Tests in `TelegramMessageExtractorTest`:
1. `extractsCaptionWhenTextIsNull`: media `Message` with `text == null` and `caption == "Пост про Codex"` returns `"Пост про Codex"`.
2. `extractsForwardOriginForUserChannelAndHiddenUser`: verifies `MessageOriginUser`, `MessageOriginChannel`, and `MessageOriginHiddenUser` labels.
3. `stripsBotMentionCaseInsensitively`: `"@My_Bot когда день рождения?"` -> `"когда день рождения?"`.
4. `splitsLongReplyWithin4096Limit`: splits a 9000-char string on line/space boundaries so every chunk is `<= 4096` chars and reassembles cleanly.

Tests in `UpdateTriggerEvaluatorTest`:
1. `triggersInGroupOnTextMentionAndCaptionMention`: group message with `mention` entity `@my_bot` in `text` or `caption_entities` returns `ANSWER`.
2. `triggersInGroupOnReplyToBotMessageWithoutMention`: group reply whose `replyToMessage.from.id == botId` returns `ANSWER`.
3. `ignoresGroupChatterWithoutMentionOrBotReply`: regular group message or reply to another user returns `IGNORE`.
4. `ignoresDisallowedChatWhenAllowlistConfigured`: when `allowedChatIds = Set.of(100L)`, chat `200L` returns `IGNORE` and chat `100L` is allowed.
5. `returnsPrivateStartOnDmStartCommandAndAnswerOnDmText`: `/start` in `private` chat returns `PRIVATE_START`; normal text in `private` returns `ANSWER`.
6. `ignoresOwnMessagesAndOtherBots`: `from.id == botId` or `from.isBot == true` returns `IGNORE`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew test --tests "com.arcx.answeringbot.bot.*Test"`
Expected: FAIL (extractor/evaluator classes not found).

- [ ] **Step 3: Implement `TelegramMessageExtractor` and `UpdateTriggerEvaluator`**

Implement the pure static/component helpers handling `text` + `caption`, `entities` + `captionEntities`, `MessageOriginUser`/`MessageOriginChannel`/`MessageOriginChat`/`MessageOriginHiddenUser`, case-insensitive `@botUsername` stripping, 4096-char safe splitting, and trigger decision evaluation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew test --tests "com.arcx.answeringbot.bot.*Test"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/java/com/arcx/answeringbot/bot/TelegramMessageExtractor.java src/main/java/com/arcx/answeringbot/bot/UpdateTriggerEvaluator.java src/test/java/com/arcx/answeringbot/bot/TelegramMessageExtractorTest.java src/test/java/com/arcx/answeringbot/bot/UpdateTriggerEvaluatorTest.java
git commit -m "feat: add Telegram message extraction and trigger evaluation"
```

---

### Task 5: `TelegramBotService` (Long Polling & End-to-End Message Flow)

**Files:**
- Create: `src/main/java/com/arcx/answeringbot/bot/TelegramBotService.java`
- Create: `src/test/java/com/arcx/answeringbot/bot/TelegramBotServiceTest.java`

**Interfaces:**
- Consumes: `BotProperties`, `BranchContextStore`, `TelegramMessageExtractor`, `UpdateTriggerEvaluator`, `LlmFallbackService`, `TelegramClient`
- Produces: `TelegramBotService` (`SmartLifecycle` managing `TelegramBotsLongPollingApplication`, `LongPollingSingleThreadUpdateConsumer`)

- [ ] **Step 1: Write failing tests in `TelegramBotServiceTest.java`**

Mock `TelegramClient` and `LlmFallbackService` (using real `BranchContextStore`, `TelegramMessageExtractor`, `UpdateTriggerEvaluator`), and test `processMessage(Message)` directly:
1. `answersForwardedReplyMentionAndStoresBotReply`: user sends `@mybot когда день рождения у codex` as a reply to a forwarded `MessageOriginChannel` post `"Сегодня релиз Codex..."`; verifies `SendChatAction("typing")` is sent, `LlmFallbackService` receives `SystemMessage` + forwarded root `UserMessage` + user question `UserMessage`, `SendMessage` is executed with `replyToMessageId == incoming.messageId`, and the returned bot `Message` is stored as `ASSISTANT` in `BranchContextStore`.
2. `usesDefaultPromptWhenUserOnlyMentionsBotOnForwardedReply`: user sends only `"@mybot"` as reply to forwarded post; verifies non-empty default prompt is passed to LLM and answered.
3. `handlesDmStartWithoutCallingLlm`: `/start` in `private` sends static greeting without calling `LlmFallbackService`.
4. `sendsSafeFallbackMessageWhenBothLlmProvidersFail`: `LlmFallbackService` throws exception -> bot replies with a short error notice instead of throwing uncaught exception.

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew test --tests com.arcx.answeringbot.bot.TelegramBotServiceTest`
Expected: FAIL (`TelegramBotService` does not exist).

- [ ] **Step 3: Implement `TelegramBotService`**

- Implements `SmartLifecycle` and `LongPollingSingleThreadUpdateConsumer`.
- Guarded by `@ConditionalOnProperty(prefix = "telegram-bot", name = "enabled", havingValue = "true", matchIfMissing = true)` (or checks `botProperties.enabled()` in `start()`).
- On `start()`: builds `OkHttpTelegramClient(botProperties.token())`, calls `GetMe` to populate `botId` and `botUsername`, creates virtual-thread executor `Executors.newVirtualThreadPerTaskExecutor()`, starts `TelegramBotsLongPollingApplication` and calls `registerBot(token, this)`.
- On `consume(Update)`: dispatches `handleUpdate(update)` on virtual-thread executor (with `try/catch` logging) so long LLM calls never block polling.
- In `processMessage(Message)`:
  - Evaluates trigger (`IGNORE` -> return; `PRIVATE_START` -> send static greeting).
  - Seeds `replyToMessage` in `BranchContextStore` if missing (including `forwardOrigin` and `text`/`caption`).
  - Strips `@botUsername` from incoming text; if blank and `replyToMessage` is present, substitutes `"Дай краткий и информативный ответ или пояснение по этому сообщению."`.
  - Records incoming `USER` node in `BranchContextStore`.
  - Sends `SendChatAction(chatId, "typing")`.
  - Builds prompt messages via `BranchContextStore#buildPromptMessages`, calls `LlmFallbackService#generateAnswer`, splits via `splitForTelegram`, sends replies (first chunk with `replyToMessageId = incoming.messageId`), and records the last sent `Message` as `ASSISTANT` in `BranchContextStore`.

- [ ] **Step 4: Run full test suite**

Run: `./gradlew test`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/java/com/arcx/answeringbot/bot/TelegramBotService.java src/test/java/com/arcx/answeringbot/bot/TelegramBotServiceTest.java
git commit -m "feat: add TelegramBotService long polling handler with branch reply flow"
```

---

### Task 6: Docker Packaging & Quick-Start Command

**Files:**
- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `.dockerignore`
- Modify: `README.md`

- [ ] **Step 1: Create `.dockerignore`**

Exclude `.git`, `.gradle`, `build`, `.idea`, `docs`, `.env` from Docker build context.

- [ ] **Step 2: Create multi-stage `Dockerfile`**

- Stage 1 (`eclipse-temurin:21-jdk-alpine`): copy `gradlew`, `gradle/`, `build.gradle`, `settings.gradle`, `src/`, run `./gradlew bootJar --no-daemon -x test`.
- Stage 2 (`eclipse-temurin:21-jre-alpine`): copy `build/libs/*.jar` to `/app/app.jar`, run as non-root `app` user with `ENTRYPOINT ["java", "-jar", "/app/app.jar"]`.

- [ ] **Step 3: Create `compose.yaml`**

Define service `answering-bot` with `build: .`, `env_file: .env`, `restart: unless-stopped`.

- [ ] **Step 4: Update `README.md` with quick Docker launch command**

Document the prerequisites (`.env` with `TELEGRAM_BOT_API`, `OPENROUTER_API`, `GEMINI_API`), BotFather Privacy Mode note (works with default Privacy Mode ON for reply-based mentions), and the one-line quick start:
```bash
docker compose up -d --build
```
Plus `docker compose logs -f` and `docker compose down`.

- [ ] **Step 5: Verify Docker config & full Gradle build/test**

Run:
- `./gradlew clean test bootJar`
- `docker compose config` (if Docker is available in the environment; verify Compose syntax)
Expected: `./gradlew clean test bootJar` outputs `BUILD SUCCESSFUL`; `docker compose config` validates cleanly.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile compose.yaml .dockerignore README.md
git commit -m "chore: add Docker multi-stage build, Compose config, and quick-start README"
```
