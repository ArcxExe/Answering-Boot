# AnsweringBot (Telegram Serverless)

Краткий и информативный Telegram-бот для групповых чатов, написанный на чистом JavaScript (ES Modules) для запуска непосредственно на инфраструктуре **Telegram Serverless** ([документация](https://core.telegram.org/bots/serverless)) без собственного сервера, VPS и Docker.

Отвечает на пересланные и обычные сообщения при упоминании `@botname`, сохраняет контекст reply-ветки во встроенной SQLite БД Telegram (`sdk/db`) с экономным бюджетом токенов (до 8 сообщений и 6 000 символов, TTL 24 ч), поддерживает поиск актуальных данных в интернете через `/search <запрос>` (Gemini Google Search Grounding) и динамическую смену системного промпта владельцем бота по Telegram ID.

## Стек и архитектура

- **Runtime**: Telegram Serverless V8 isolate (`tgcloud/` — чистый ES JavaScript без `node_modules`)
- **SDK**: встроенные `sdk/api` (Telegram Bot API, авторизован платформой автоматически), `sdk/db` (встроенная SQLite БД) и `sdk/fetch` (исходящий HTTP к OpenRouter и Gemini)
- **CLI**: `@tgcloud/cli` `^0.2.0` (только локальная dev-зависимость для деплоя)
- **Тесты**: встроенный `node:test` (Node.js 18+)

### Структура проекта

```text
tgcloud/
├─ handlers/
│  └─ message.js                     # Точка входа для входящих сообщений (allowed_updates: message)
├─ lib/
│  ├─ bot-processor.js               # Основной цикл обработки сообщений, /search и админ-команд
│  ├─ branch-context-store.js        # Форматирование контекста, лимит символов и in-memory fallback
│  ├─ sqlite-branch-context-store.js # Постоянное хранилище reply-веток в Telegram SQLite (sdk/db)
│  ├─ settings-store.js              # Постоянное хранилище системного промпта в Telegram SQLite (`bot_settings`)
│  ├─ config.js                      # Конфигурация, бюджет контекста, OWNER_ID и промпт «Подсолнух»
│  ├─ llm-client.js                  # HTTP-клиенты OpenRouter и Gemini (+ Google Search Grounding)
│  ├─ llm-fallback.js                # Переключение OpenRouter -> Gemini
│  ├─ message-extractor.js           # Извлечение текста/подписей/forward_origin, команды, @упоминания, разбиение >4096
│  ├─ trigger-evaluator.js           # Правила срабатывания в группах и ЛС
│  └─ secrets.js                     # Генерируется из .env перед деплоем (в .gitignore!)
└─ schema.js                         # Таблицы `branch_nodes` и `bot_settings` для встроенной SQLite БД Telegram
scripts/
└─ generate-secrets.mjs              # Генератор tgcloud/lib/secrets.js из .env / process.env
test/                                # Автотесты (node:test)
```

## Быстрый деплой на Telegram Serverless

### 1. Включите Serverless в `@BotFather`

Откройте `@BotFather` → ваш бот → **Serverless** и включите его.
Затем перейдите в **Serverless → CLI Access → Access token** и скопируйте CLI-токен вида `app<id>:<secret>`.

> **Важно:** в Telegram Serverless обычный `TELEGRAM_BOT_API` в коде **не нужен** — встроенный `api` из `'sdk'` уже привязан к вашему боту платформой Telegram. Для деплоя используется только отдельный CLI-токен.

### 2. Установите CLI и привяжите бота

Требуется Node.js 18 или новее:

```bash
npm install
npx tgcloud login
```

CLI сохранит токен локально в git-ignored папке `.tgcloud/`.

### 3. Задайте ключи OpenRouter / Gemini и `OWNER_ID`

Скопируйте `.env.example` в `.env` и заполните ключи:

```bash
cp .env.example .env
```

```env
OPENROUTER_API=...
GEMINI_API=...
OWNER_ID=123456789
```

> Свой `OWNER_ID` можно узнать, отправив боту `/id` в личные сообщения. Файлы `.env` и генерируемый `tgcloud/lib/secrets.js` добавлены в `.gitignore` и никогда не коммитятся в Git.

### 4. Выложите бота и примените миграцию БД

```bash
npm run deploy
npm run migrate
```

- `npm run deploy` обновит `tgcloud/lib/secrets.js` из `.env` и выполнит `npx tgcloud push`.
- `npm run migrate` (`npx tgcloud migrate`) создаст таблицы `branch_nodes` и `bot_settings` во встроенной SQLite БД Telegram. *(Если забыть выполнить миграцию, бот не упадёт — он временно откатится на in-memory кэш до применения миграции.)*

Проверить статус и синхронизацию вебхука:

```bash
npm run status
npm run webhook
```

### 5. Тестовый запуск без деплоя (`tgcloud run`)

```bash
npm run build:secrets
npx tgcloud run handlers/message '{ message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "Test" }, text: "/start" }'
```

## Использование и команды

### В группе и личных сообщениях
- Добавьте бота в группу (стандартный Privacy Mode в `@BotFather` можно не отключать).
- Перешлите сообщение или выберите существующее, сделайте на него **Reply** и упомяните `@username` бота (с вопросом или без).
- Для уточнений в той же ветке достаточно делать **Reply** на ответ бота без повторного упоминания — бот помнит контекст ветки (до 8 сообщений / 6 000 символов в течение 24 часов), даже после холодных стартов.
- `/search <запрос>` (или `/search@botname <запрос>`, также работает в reply на сообщение) — прямой запрос в **Google Gemini API** с включённым **Google Search Grounding** для получения актуальных фактов и до 3 ссылок на источники.
- `/id` (в ЛС или `/id@botname` в группе) — показывает ваш Telegram User ID.

### Админ-команды (только для `OWNER_ID` / `ADMIN_USER_IDS`)
- `/prompt` — показать активный системный промпт (пользовательский или по умолчанию).
- `/setprompt <новый промпт>` — сохранить новый системный промпт в БД `bot_settings` (применяется сразу для всех чатов).
- `/resetprompt` — сбросить системный промпт обратно на стандартный («Подсолнух»).

## Локальные автотесты

Запускаются локально через встроенный `node:test` (без подключения к интернету и без `.env`):

```bash
npm test
```
