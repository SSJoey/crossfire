export type Tier = 'high' | 'medium' | 'low';

export interface TierSettings {
  label: string;
  shadows: boolean;
  bloom: boolean;
  /** Upper bound on the device pixel ratio. */
  maxPixelRatio: number;
}

export const TIERS: Record<Tier, TierSettings> = {
  high: { label: 'High: shadows and glow', shadows: true, bloom: true, maxPixelRatio: 2 },
  medium: { label: 'Medium: shadows', shadows: true, bloom: false, maxPixelRatio: 2 },
  low: { label: 'Low: office laptop', shadows: false, bloom: false, maxPixelRatio: 1 },
};

export const DEFAULT_TIER: Tier = 'medium';
export const TIER_KEY = 'crossfire.gfx';

/** The part of localStorage we use, so tests can pass a fake. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isTier(v: unknown): v is Tier {
  return v === 'high' || v === 'medium' || v === 'low';
}

/** `?gfx=` beats the saved choice, which beats the default. Storage errors are ignored. */
export function resolveTier(search: string, store: Store | undefined): Tier {
  const fromUrl = new URLSearchParams(search).get('gfx');
  if (isTier(fromUrl)) return fromUrl;
  try {
    const saved = store?.getItem(TIER_KEY);
    if (isTier(saved)) return saved;
  } catch {
    // Private window or blocked site data: fall through to the default.
  }
  return DEFAULT_TIER;
}

export function saveTier(store: Store | undefined, tier: Tier): void {
  try {
    store?.setItem(TIER_KEY, tier);
  } catch {
    // Not saved; the default applies next time.
  }
}

export function pixelRatioFor(tier: Tier, devicePixelRatio: number): number {
  return Math.min(devicePixelRatio, TIERS[tier].maxPixelRatio);
}
