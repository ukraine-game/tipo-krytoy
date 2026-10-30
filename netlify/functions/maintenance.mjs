import { runScheduledMaintenance } from './api.mjs';

export default async function maintenance() {
  try {
    await runScheduledMaintenance();
  } catch (error) {
    console.error('AFK Bank scheduled maintenance failed:', error?.message || error);
    throw error;
  }
}

// Runs every five minutes. Election boundaries (13:10 and 14:20 Kyiv time)
// are exact multiples of five minutes; the API computes the timezone itself.
export const config = { schedule: '*/5 * * * *' };
