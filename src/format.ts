/**
 * Number formatting.
 *
 * Pinned to Spanish rather than the device locale: the interface is Spanish, so
 * a phone set to English would otherwise group digits the English way, and the
 * share text — which travels to other people — would differ between senders.
 *
 * Note that Spanish deliberately does not group four-digit numbers: 1000 stays
 * "1000" while 10000 becomes "10.000". That is correct CLDR behaviour, not a
 * missing separator.
 */
const LOCALE = 'es-ES';

export function formatScore(n: number): string {
  return n.toLocaleString(LOCALE);
}
