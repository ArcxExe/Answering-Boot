import { secretaryProcessor } from '../lib/runtime.js';

/**
 * Telegram Serverless update handler for `deleted_business_messages` updates (Secretary Mode).
 * Removes deleted messages from stored business chat history.
 */
export default async function (deleted) {
  try {
    await secretaryProcessor.handleDeletedBusinessMessages(deleted);
  } catch (err) {
    console.error(
      `Unhandled error while processing deleted_business_messages in chat ${deleted?.chat?.id}`,
      err
    );
  }
}
