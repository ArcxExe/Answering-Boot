import { secretaryProcessor } from '../lib/runtime.js';

/**
 * Telegram Serverless update handler for `edited_business_message` updates (Secretary Mode).
 * Keeps stored business chat history synchronized when a message is edited.
 */
export default async function (message) {
  try {
    await secretaryProcessor.handleEditedBusinessMessage(message);
  } catch (err) {
    console.error(
      `Unhandled error while processing edited_business_message ${message?.message_id} in chat ${message?.chat?.id}`,
      err
    );
  }
}
