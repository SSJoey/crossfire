/** Returns HP after taking damage. Never below 0; invalid or negative damage is ignored. */
export function applyDamage(hp: number, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return hp;
  return Math.max(0, hp - amount);
}

/** Returns HP after healing. Never above maxHp; invalid or negative heals are ignored. */
export function applyHeal(hp: number, amount: number, maxHp: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return hp;
  return Math.min(maxHp, hp + amount);
}
