import { secretaryProcessor } from '../lib/runtime.js';

/**
 * Telegram Serverless update handler for `callback_query` updates.
 * Handles inline buttons from the Secretary Mode "Manage Bot" panel (pause, resume, clear history).
 */
export default async function (callbackQuery) {
  try {
    await secretaryProcessor.handleCallbackQuery(callbackQuery);
  } catch (err) {
    console.error(
      `Unhandled error while processing callback_query ${callbackQuery?.id}`,
      err
    );
  }
}
