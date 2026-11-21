# AnsweringBot (Telegram Serverless)

Краткий и информативный Telegram-бот для групповых чатов, написанный на чистом JavaScript (ES Modules) для запуска непосредственно на инфраструктуре **Telegram Serverless** ([документация](https://core.telegram.org/bots/serverless)) без собственного сервера, VPS и Docker.

Отвечает на пересланные и обычные сообщения при упоминании `@botname`, сохраняет контекст reply-ветки во встроенной SQLite БД Telegram (`sdk/db`) с экономным бюджетом токенов (до 8 сообщений и 6 000 символов, TTL 24 ч), поддерживает поиск актуальных данных через `/search <запрос>` (Gemini Google Search Grounding), динамическую смену системного промпта владельцем по Telegram ID и **Режим секретаря Telegram (Secretary Mode / Business Bots)** для ответов от имени вашего аккаунта в личных чатах.

## Стек и архитектура

- **Runtime**: Telegram Serverless V8 isolate (`tgcloud/` — чистый ES JavaScript без `node_modules`)
- **SDK**: встроенные `sdk/api` (Telegram Bot API, авторизован платформой автоматически), `sdk/db` (встроенная SQLite БД) и `sdk/fetch` (исходящий HTTP к OpenRouter и Gemini)
- **CLI**: `@tgcloud/cli` `^0.2.0` (только локальная dev-зависимость для деплоя)
- **Тесты**: встроенный `node:test` (Node.js 18+)

### Структура проекта

```text
tgcloud/
├─ handlers/
│  ├─ message.js                     # Обычные сообщения, группы, ЛС, /search, /start bizChat<id>
│  ├─ callback_query.js              # Inline-кнопки управления секретарём («Manage Bot»)
│  ├─ business_connection.js         # Подключение, изменение прав и отключение режима секретаря
│  ├─ business_message.js            # Входящие и исходящие сообщения подключённого аккаунта
│  ├─ edited_business_message.js     # Синхронизация редактирования сообщений в истории секретаря
│  └─ deleted_business_messages.js   # Удаление стёртых сообщений из памяти секретаря
├─ lib/
│  ├─ runtime.js                     # Общая инициализация SDK, хранилищ и LLM-клиентов
│  ├─ bot-processor.js               # Обработка групп/ЛС, /search, админ-команд и deep link
│  ├─ secretary-processor.js         # Логика режима секретаря (права, защита от циклов, пауза)
│  ├─ business-store.js              # SQLite хранилище подключений, переписок и пауз секретаря
│  ├─ branch-context-store.js        # Форматирование контекста, лимит символов и in-memory fallback
│  ├─ sqlite-branch-context-store.js # Постоянное хранилище reply-веток в Telegram SQLite (sdk/db)
│  ├─ settings-store.js              # Постоянное хранилище системных промптов (`bot_settings`)
│  ├─ config.js                      # Конфигурация, бюджет контекста, OWNER_ID и дефолтные промпты
│  ├─ llm-client.js                  # HTTP-клиенты OpenRouter и Gemini (+ Google Search Grounding)
│  ├─ llm-fallback.js                # Переключение OpenRouter -> Gemini
│  ├─ message-extractor.js           # Извлечение текста/подписей/forward_origin, команды, @упоминания, разбиение >4096
│  ├─ trigger-evaluator.js           # Правила срабатывания в группах и ЛС
│  └─ secrets.js                     # Генерируется из .env перед деплоем (в .gitignore!)
└─ schema.js                         # Таблицы `branch_nodes`, `bot_settings`, `business_*`
scripts/
└─ generate-secrets.mjs              # Генератор tgcloud/lib/secrets.js из .env / process.env
test/                                # Автотесты (node:test)
```

## Быстрый деплой на Telegram Serverless

### 1. Включите Serverless и Secretary Mode в `@BotFather`

1. Откройте `@BotFather` → ваш бот → **Serverless** и включите его.
2. Перейдите в **Serverless → CLI Access → Access token** и скопируйте CLI-токен вида `app<id>:<secret>`.
3. Для работы **режима секретаря** дополнительно включите **Secretary Mode** (Business Mode) в настройках бота в `@BotFather`.

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

> Свой `OWNER_ID` можно узнать, отправив боту `/id` в личные сообщения. Когда задан `OWNER_ID`, режим секретаря по умолчанию работает только для владельца (чтобы посторонние не тратили ваши лимиты OpenRouter/Gemini; для публичного доступа задайте `SECRETARY_ALLOW_ALL=true`). Файлы `.env` и генерируемый `tgcloud/lib/secrets.js` добавлены в `.gitignore` и никогда не коммитятся в Git.

### 4. Выложите бота, примените миграцию БД и проверьте вебхук

```bash
npm run deploy
npm run migrate
npm run webhook
```

- `npm run deploy` обновит `tgcloud/lib/secrets.js` из `.env` и выполнит `npx tgcloud push`.
- `npm run migrate` (`npx tgcloud migrate`) создаст таблицы `branch_nodes`, `bot_settings`, `business_connections`, `business_messages` и `business_chat_states` во встроенной SQLite БД Telegram. *(До применения миграции бот не упадёт — временно сработает in-memory fallback.)*
- `npm run webhook` проверит синхронизацию всех 6 обработчиков (если статус `Out of sync`, выполните `npx tgcloud webhook sync`).

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

### Режим секретаря (Telegram Business Bots)
1. Включите **Secretary Mode** для бота в `@BotFather`.
2. В настройках Telegram подключите бота к своему аккаунту, выберите чаты и нужные права (`can_reply` для ответов, `can_read_messages` для отметки о прочтении).
3. Бот автоматически будет:
   - отвечать собеседникам в выбранных чатах от вашего имени через `business_connection_id` (с отдельным вежливым системным промптом секретаря);
   - учитывать ваши собственные ручные ответы в переписке (не отвечая сам себе и не зацикливаясь на `sender_business_bot` / `is_from_offline`);
   - синхронизировать редактирование (`edited_business_message`) и удаление (`deleted_business_messages`) сообщений в памяти чата;
   - отмечать входящие сообщения прочитанными (`readBusinessMessage`) после успешного ответа, если выдано право `can_read_messages`.
4. В верхней панели любого управляемого чата кнопка **«Manage Bot»** открывает в ЛС с ботом панель (`/start bizChat<chat_id>`) с кнопками паузы/возобновления секретаря и очистки памяти именно этого чата.

Команды режима секретаря в ЛС с ботом:
- `/secretary` — статус подключения, выданные права и число чатов на паузе.
- `/secretary_prompt` — посмотреть активный системный промпт секретаря.
- `/set_secretary_prompt <текст>` — задать свой системный промпт для режима секретаря.
- `/reset_secretary_prompt` — вернуть стандартный промпт секретаря.

### Админ-команды для группового/обычного режима (только `OWNER_ID` / `ADMIN_USER_IDS`)
- `/prompt` — показать активный системный промпт.
- `/setprompt <новый промпт>` — сохранить новый системный промпт в БД `bot_settings` (применяется сразу для всех чатов).
- `/resetprompt` — сбросить системный промпт обратно на стандартный («Подсолнух»).

## Локальные автотесты

Запускаются локально через встроенный `node:test` (без подключения к интернету и без `.env`):

```bash
npm test
```
