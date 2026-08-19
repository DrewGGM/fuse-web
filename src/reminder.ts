/**
 * The daily reminder, on the web.
 *
 * The Android build schedules a real local notification. A browser cannot do
 * that reliably: web notifications need the page or a service worker to be
 * alive at the right moment, and a phone browser will not be. Rather than ship
 * a switch that silently does nothing — the exact failure this feature was
 * written to fix in the first place — the web build says so and points at the
 * app, which is where a daily reminder actually works.
 *
 * The interface matches the Android one so `main.ts` stays identical between
 * the two builds.
 */

export type ReminderOutcome = 'scheduled' | 'denied' | 'unsupported';

/**
 * Always false on the web.
 *
 * Notification permission can be granted here, but a scheduled *daily* reminder
 * cannot: there is no reliable wake-up. Claiming support and then not firing is
 * worse than declining.
 */
export function isSupported(): boolean {
  return false;
}

export async function enable(): Promise<ReminderOutcome> {
  return 'unsupported';
}

export async function disable(): Promise<void> {
  // Nothing was ever scheduled.
}

/**
 * Signature matches the Android build's so `main.ts` is byte-identical between
 * the two repositories. The argument is deliberately unused.
 */
export async function restore(_enabled: boolean): Promise<void> {
  // Nothing was ever scheduled, so there is nothing to restore.
}
