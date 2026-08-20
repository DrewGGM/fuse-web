/**
 * Install prompt and offline readiness.
 *
 * The web build has two jobs beyond being playable: it should install to a home
 * screen like an app, and it should keep working with no connection, because a
 * daily puzzle is played on commutes.
 *
 * Both are handled here so `main.ts` stays the same file as the Android build's.
 */

/** Chrome fires this instead of prompting, handing us the decision. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let onAvailabilityChange: ((available: boolean) => void) | null = null;

export function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari predates the standard and reports it here instead.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * Starts listening for install availability.
 *
 * Deliberately does not prompt on its own: an install banner on first load, from
 * a game nobody has played yet, is the web equivalent of an interstitial. The
 * button appears and the player decides.
 */
export function watchInstall(onChange: (available: boolean) => void): void {
  onAvailabilityChange = onChange;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    onAvailabilityChange?.(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    onAvailabilityChange?.(false);
  });
}

/** Shows the browser's install dialog. Returns whether it was accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  // The event is single-use; a second prompt() throws.
  deferredPrompt = null;
  onAvailabilityChange?.(false);

  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    return choice.outcome === 'accepted';
  } catch {
    return false;
  }
}

/**
 * Registers the service worker that makes the game work offline.
 *
 * Failure here is not worth surfacing: the game still runs, it just needs the
 * network to load next time.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  const register = (): void => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // Unsupported, blocked by policy, or served from a context that forbids
      // it. Nothing the player can act on.
    });
  };

  // Waiting for `load` keeps registration off the critical path, but only if
  // `load` is still ahead of us. Module scripts normally run before it, so this
  // usually holds — "usually" being the problem: a caller that reaches this
  // after the event has fired would attach a listener to something that has
  // already happened and register nothing, for the whole session, silently, and
  // the failure looks exactly like a browser that does not support offline.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
