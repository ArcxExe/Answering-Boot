import { index, integer, table, text } from 'sdk/db';

/**
 * Persistent reply-branch nodes stored in Telegram Serverless built-in SQLite.
 * Note: Telegram Serverless disables PRAGMA foreign_keys, so parent links are logical.
 */
export const branchNodes = table(
  'branch_nodes',
  {
    nodeKey: text('node_key').primaryKey(),
    chatId: integer('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
    parentMessageId: integer('parent_message_id'),
    role: text('role').notNull(),
    authorLabel: text('author_label'),
    forwardedFrom: text('forwarded_from'),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    createdAtIdx: index('idx_branch_nodes_created_at').on(t.createdAt),
  })
);

/**
 * Persistent bot key-value settings (e.g. dynamic system prompt updated by admins).
 */
export const botSettings = table('bot_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

