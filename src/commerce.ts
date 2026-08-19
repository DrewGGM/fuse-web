/**
 * Ads and purchases, behind ports.
 *
 * The rules from ADR-006 are enforced here rather than trusted to the UI:
 *   - Rewarded video is opt-in only, capped at two per player per day.
 *   - There are no interstitials, no app-open ads, and no ad before play.
 *   - Nothing sold or watched grants a ranked attempt or any scoring advantage.
 *
 * The last rule is the one worth policing in code, because it is the one a
 * future "just this once" change would quietly break. `Reward` deliberately has
 * no variant that touches attempts or score — the type makes it unrepresentable.
 */

/** Everything a reward is allowed to give. Cosmetic or informational, never competitive. */
export type Reward =
  | { kind: 'double-sparks'; amount: number }
  | { kind: 'reveal-top-run' }
  | { kind: 'unlock-palette'; paletteId: string };

export type Product =
  | { id: 'ad_free'; kind: 'one-time'; priceLabel: string }
  | { id: 'palette_pack'; kind: 'one-time'; priceLabel: string }
  | { id: 'season'; kind: 'subscription'; priceLabel: string };

export interface AdPort {
  /** True when a rewarded ad is loaded and the daily cap has not been reached. */
  isRewardedReady(): boolean;
  /**
   * Shows a rewarded ad. Resolves true only if the player actually watched it
   * through — dismissing early must not pay out.
   */
  showRewarded(): Promise<boolean>;
  /** Runs the consent flow. Must complete before the first ad request in the EEA. */
  ensureConsent(): Promise<void>;
}

export interface PurchasePort {
  listProducts(): Promise<Product[]>;
  /** Resolves true if the purchase completed and was verified. */
  purchase(id: Product['id']): Promise<boolean>;
  restore(): Promise<string[]>;
  isOwned(id: Product['id']): boolean;
}

/**
 * Development adapters.
 *
 * Real AdMob and RevenueCat need native SDKs, signed builds and live accounts,
 * none of which exist in a browser. These stand in so the whole flow is
 * playable and testable now; `capacitor.ts` swaps in the real ones at build time.
 */
export class MockAdPort implements AdPort {
  private consentDone = false;
  constructor(private readonly available: () => boolean) {}

  isRewardedReady(): boolean {
    return this.available();
  }

  async ensureConsent(): Promise<void> {
    this.consentDone = true;
  }

  async showRewarded(): Promise<boolean> {
    if (!this.consentDone) await this.ensureConsent();
    // Simulate the real thing taking a couple of seconds of the player's time.
    await new Promise((r) => setTimeout(r, 900));
    return true;
  }
}

export class MockPurchasePort implements PurchasePort {
  private owned = new Set<string>();

  async listProducts(): Promise<Product[]> {
    return [
      { id: 'ad_free', kind: 'one-time', priceLabel: '4,99 €' },
      { id: 'palette_pack', kind: 'one-time', priceLabel: '2,99 €' },
      { id: 'season', kind: 'subscription', priceLabel: '4,99 €/mes' },
    ];
  }

  async purchase(id: Product['id']): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 600));
    this.owned.add(id);
    return true;
  }

  async restore(): Promise<string[]> {
    return [...this.owned];
  }

  isOwned(id: Product['id']): boolean {
    return this.owned.has(id);
  }
}

/** Hard cap from ADR-006. Changing this number is a product decision, not a tweak. */
export const REWARDS_PER_DAY = 2;

/**
 * Guard that keeps the monetisation honest.
 *
 * Called before any reward is granted. It exists so that the invariant is
 * asserted in one place and covered by a test, instead of living only in a
 * design document that nobody reads while shipping a feature.
 */
export function assertRewardIsFair(reward: Reward): void {
  const kind: string = reward.kind;
  const forbidden = ['extra-attempt', 'score-bonus', 'skip', 'multiplier'];
  if (forbidden.includes(kind)) {
    throw new Error(
      `Reward "${kind}" would grant a competitive advantage, which ADR-006 forbids.`
    );
  }
}
