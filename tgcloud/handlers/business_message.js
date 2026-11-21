import { secretaryProcessor } from '../lib/runtime.js';

/**
 * Telegram Serverless update handler for `business_message` updates (Secretary Mode).
 * Receives new messages from chats managed by a connected Telegram account.
 */
export default async function (message) {
  try {
    await secretaryProcessor.handleBusinessMessage(message);
  } catch (err) {
    console.error(
      `Unhandled error while processing business_message ${message?.message_id} in chat ${message?.chat?.id}`,
      err
    );
  }
}
