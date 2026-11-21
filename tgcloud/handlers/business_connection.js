import { secretaryProcessor } from '../lib/runtime.js';

/**
 * Telegram Serverless update handler for `business_connection` updates (Secretary Mode).
 * Triggered when a user connects, edits rights, or disconnects the bot from their account.
 */
export default async function (connection) {
  try {
    await secretaryProcessor.handleBusinessConnection(connection);
  } catch (err) {
    console.error(
      `Unhandled error while processing business_connection ${connection?.id}`,
      err
    );
  }
}
