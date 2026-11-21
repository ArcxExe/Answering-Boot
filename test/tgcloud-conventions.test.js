import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSecretsObject,
  parseEnvFile,
  renderSecretsModule,
} from '../scripts/generate-secrets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const TGCLOUD_DIR = resolve(PROJECT_ROOT, 'tgcloud');

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (extname(full) === '.js') {
      files.push(full);
    }
  }
  return files;
}

describe('Telegram Serverless (tgcloud) runtime conventions', () => {
  const jsFiles = collectJsFiles(TGCLOUD_DIR);

  it('has all required update handlers and schema.js in tgcloud/', () => {
    const relPaths = jsFiles.map((f) => relative(TGCLOUD_DIR, f));
    assert.ok(relPaths.includes('handlers/message.js'));
    assert.ok(relPaths.includes('handlers/callback_query.js'));
    assert.ok(relPaths.includes('handlers/business_connection.js'));
    assert.ok(relPaths.includes('handlers/business_message.js'));
    assert.ok(relPaths.includes('handlers/edited_business_message.js'));
    assert.ok(relPaths.includes('handlers/deleted_business_messages.js'));
    assert.ok(relPaths.includes('schema.js'));
  });

  it('uses only sdk/* or relative .js imports inside tgcloud/ (no npm or node:* imports)', () => {
    const importRegex = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

    for (const file of jsFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(PROJECT_ROOT, file);
      let match;
      while ((match = importRegex.exec(source)) !== null) {
        const specifier = match[1];
        if (specifier === 'sdk' || specifier.startsWith('sdk/')) {
          continue;
        }
        assert.ok(
          specifier.startsWith('./') || specifier.startsWith('../'),
          `${rel}: bare non-SDK import "${specifier}" is forbidden in Telegram Serverless`
        );
        assert.ok(
          specifier.endsWith('.js'),
          `${rel}: relative import "${specifier}" must include .js extension`
        );
        const resolvedTarget = resolve(dirname(file), specifier);
        assert.ok(
          resolvedTarget.startsWith(TGCLOUD_DIR),
          `${rel}: import "${specifier}" escapes tgcloud/`
        );
      }
    }
  });

  it('does not use Node globals or timer APIs unavailable in Telegram Serverless V8 isolates', () => {
    const forbidden = [/\bprocess\.env\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\brequire\(/];

    for (const file of jsFiles) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const rel = relative(PROJECT_ROOT, file);
      for (const pattern of forbidden) {
        assert.equal(
          pattern.test(source),
          false,
          `${rel}: contains forbidden runtime construct ${pattern}`
        );
      }
    }
  });
  it('does not declare foreign keys in tgcloud/schema.js (forbidden on Telegram Serverless)', () => {
    const schemaSource = readFileSync(resolve(TGCLOUD_DIR, 'schema.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal(/\.references\s*\(/.test(schemaSource), false);
    assert.equal(/\bforeignKey\s*\(/.test(schemaSource), false);
  });
});

describe('scripts/generate-secrets.mjs', () => {
  it('parses .env files with comments, quotes, and escapes', () => {
    const parsed = parseEnvFile(`
      # comment
      OPENROUTER_API="or-secret-123"
      export GEMINI_API='gm-secret-456'
      ALLOWED_CHAT_IDS=-1001, -1002 # inline comment
      SYSTEM_PROMPT="Line 1\\nLine 2"
    `);

    assert.equal(parsed.OPENROUTER_API, 'or-secret-123');
    assert.equal(parsed.GEMINI_API, 'gm-secret-456');
    assert.equal(parsed.ALLOWED_CHAT_IDS, '-1001, -1002');
    assert.equal(parsed.SYSTEM_PROMPT, 'Line 1\nLine 2');
  });

  it('builds normalized secrets object and valid JS module', () => {
    const secrets = buildSecretsObject({
      OPENROUTER_API: 'or-key',
      GEMINI_API: 'gm-key',
      ALLOWED_CHAT_IDS: '-1001, -1002, bad',
      OWNER_ID: '42',
      ADMIN_USER_IDS: '42, 777, -5, invalid',
      SECRETARY_PROMPT: 'Вежливый секретарь',
      SECRETARY_ALLOW_ALL: 'true',
      SECRETARY_MARK_AS_READ: 'false',
      BOT_ID: '12345',
      BOT_USERNAME: '@my_bot',
      BRANCH_MAX_DEPTH: '10',
      BRANCH_MAX_CONTEXT_CHARS: '5000',
    });

    assert.deepEqual(secrets.allowedChatIds, [-1001, -1002]);
    assert.deepEqual(secrets.adminUserIds, [42, 777]);
    assert.equal(secrets.secretarySystemPrompt, 'Вежливый секретарь');
    assert.equal(secrets.secretaryAllowAll, true);
    assert.equal(secrets.secretaryMarkAsRead, false);
    assert.equal(secrets.botId, 12345);
    assert.equal(secrets.botUsername, 'my_bot');
    assert.equal(secrets.branchMaxDepth, 10);
    assert.equal(secrets.branchMaxContextChars, 5000);

    const rendered = renderSecretsModule(secrets);
    assert.match(rendered, /export const SECRETS = Object\.freeze\(/);
    assert.match(rendered, /"openRouterApiKey": "or-key"/);
    assert.match(rendered, /"adminUserIds": \[\s*42,\s*777\s*\]/);
    assert.match(rendered, /"secretaryAllowAll": true/);
  });
});
