# AnsweringBot

Краткий и информативный Telegram-бот для групповых чатов на Java 21, Spring Boot 4.1.2 и Spring AI 2.0.0.
Отвечает на пересланные и обычные сообщения при упоминании `@botname`, сохраняет контекст внутри reply-ветки, использует OpenRouter как основной провайдер с автоматическим переключением на Gemini при сбоях или лимитах.

## Стек технологий

- Java 21
- Spring Boot 4.1.2 + Spring AI 2.0.0 (OpenRouter + Google Gemini)
- `telegrambots-longpolling` 10.3.0
- Docker / Docker Compose

## Быстрый запуск в Docker

1. Убедитесь, что в корне проекта заполнен файл `.env` (по шаблону `.env.example`):

```env
TELEGRAM_BOT_API=...
OPENROUTER_API=...
GEMINI_API=...
```

2. Запустите бота одной командой:

```bash
docker compose up -d --build
```

Полезные команды:

```bash
# Смотреть логи
docker compose logs -f

# Остановить и удалить контейнер
docker compose down
```

## Использование в группе Telegram

- Добавьте бота в группу (стандартный Privacy Mode в `@BotFather` можно не отключать).
- Перешлите сообщение или выберите существующее, сделайте на него **Reply** и упомяните `@username` бота (с вопросом или без).
- Для уточнений в той же ветке достаточно делать **Reply** уже на ответ бота.

## Локальный запуск и тесты (без Docker)

```bash
./gradlew test
./gradlew bootRun
```
