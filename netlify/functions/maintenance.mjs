import { runScheduledMaintenance } from './api.mjs';

export default async function maintenance() {
  try {
    await runScheduledMaintenance();
  } catch (error) {
    console.error('AFK Bank scheduled maintenance failed:', error?.message || error);
    throw error;
  }
}

// Runs every minute so manually scheduled elections activate promptly.
// All election times are evaluated in Europe/Kyiv, including DST changes.
export const config = { schedule: '* * * * *' };
