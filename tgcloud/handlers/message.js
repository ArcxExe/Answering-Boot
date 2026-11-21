import { processor } from '../lib/runtime.js';

/**
 * Telegram Serverless update handler for incoming `message` updates.
 */
export default async function (message) {
  try {
    await processor.processMessage(message);
  } catch (err) {
    console.error(
      `Unhandled error while processing message ${message?.message_id} in chat ${message?.chat?.id}`,
      err
    );
  }
}
