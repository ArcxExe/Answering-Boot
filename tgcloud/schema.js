import { boolean, index, integer, table, text } from 'sdk/db';

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
 * Persistent bot key-value settings (e.g. dynamic system prompts updated by admins/owners).
 */
export const botSettings = table('bot_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Active and historical Telegram Business (Secretary Mode) connections.
 */
export const businessConnections = table(
  'business_connections',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull(),
    userChatId: integer('user_chat_id').notNull(),
    userLabel: text('user_label'),
    isEnabled: boolean('is_enabled').notNull().default(false),
    canReply: boolean('can_reply').notNull().default(false),
    canReadMessages: boolean('can_read_messages').notNull().default(false),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_business_connections_user_id').on(t.userId),
  })
);

/**
 * Isolated per-connection conversation history for Telegram Secretary Mode private chats.
 */
export const businessMessages = table(
  'business_messages',
  {
    entryKey: text('entry_key').primaryKey(),
    businessConnectionId: text('business_connection_id').notNull(),
    chatId: integer('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
    role: text('role').notNull(),
    authorLabel: text('author_label'),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    chatIdx: index('idx_business_messages_chat').on(t.businessConnectionId, t.chatId, t.createdAt),
    createdAtIdx: index('idx_business_messages_created_at').on(t.createdAt),
  })
);

/**
 * Per-chat Secretary Mode pause/resume controls managed via "Manage Bot" deep link.
 */
export const businessChatStates = table(
  'business_chat_states',
  {
    stateKey: text('state_key').primaryKey(),
    userId: integer('user_id').notNull(),
    chatId: integer('chat_id').notNull(),
    paused: boolean('paused').notNull().default(false),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_business_chat_states_user_id').on(t.userId),
  })
);

