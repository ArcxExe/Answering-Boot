# AGENTS.md — AnsweringBot (Telegram Serverless)

This repository is a Telegram Serverless (`@tgcloud/cli` 0.2.0+) bot written in plain ES JavaScript.

## Runtime Rules (Telegram Serverless V8 Isolate)

- **Only `tgcloud/` is deployed**: `tgcloud/handlers/`, `tgcloud/lib/`, `tgcloud/schema.js`.
- **No `node_modules` at runtime**: inside `tgcloud/`, only import from `'sdk'`, `'sdk/*'` (`sdk/api`, `sdk/fetch`, `sdk/db`), or relative paths inside `tgcloud/` **with explicit `.js` extension** (e.g. `../lib/config.js`).
- **No Node.js globals or timers**: never use `process.env`, `fs`, `require`, `setTimeout`, or `setInterval` inside `tgcloud/`.
- **Execution budget**: V8 isolate execution has a hard ~10.4s ceiling — keep LLM calls direct without retry backoff sleeps.
- **Bot API token is built in**: `api` from `'sdk'` is pre-authenticated; never store `TELEGRAM_BOT_API` in code.
- **External API keys**: `OPENROUTER_API` and `GEMINI_API` are read locally from `.env` by `scripts/generate-secrets.mjs` to generate git-ignored `tgcloud/lib/secrets.js` before `npx tgcloud push`. Never commit `.env`, `.tgcloud/`, or `tgcloud/lib/secrets.js`.
- **Handlers are flat**: `tgcloud/handlers/message.js` exports `default async function (message, ctx)` where `message` is already unwrapped `update.message`.

## Development Commands

- Run offline unit & convention tests: `npm test`
- Generate local `tgcloud/lib/secrets.js` from `.env`: `npm run build:secrets`
- Deploy modules to Telegram Serverless: `npm run deploy`
- Inspect deployment diff/status: `npm run status` / `npm run diff`
