import reference from "../../data/reference/forever-xp.json";

/** Source-confirmed Forever curve. Classic compatibility remains unverified. */
export const XP_THRESHOLDS: readonly number[] = reference.thresholds;
export const MAX_LEVEL = 120;
export const MAX_XP = XP_THRESHOLDS[120];
export const boundedXp = (xp: number) => Math.max(0, Math.min(MAX_XP, Math.floor(Number.isFinite(xp) ? xp : 0)));
export function xpForLevel(level: number): number {
  return XP_THRESHOLDS[Math.max(0, Math.min(119, Math.floor(level) - 1))];
}
export function levelForXp(xp: number): number {
  const value = boundedXp(xp);
  let lo = 0, hi = 119;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (value >= XP_THRESHOLDS[mid]) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
export function nextLevelXp(level: number): number | null {
  return level >= MAX_LEVEL ? null : XP_THRESHOLDS[Math.max(1, Math.floor(level))];
}
/** Forever f510; named fields adapt the original stat slots to this project's API. */
export function derivedAttributes(stats: Record<string, number>) {
  const strength = stats.strength ?? 1, dexterity = stats.agility ?? 1,
    intelligence = stats.intellect ?? 1, intuition = stats.intuition ?? 1,
    vitality = stats.endurance ?? 1;
  return {
    level: Math.max(1, Math.trunc(Math.fround(Math.fround(Math.floor((strength + dexterity) / 2) + Math.floor((intelligence + intuition) / 8)) * Math.fround(.80645)))),
    maxHp: vitality + Math.floor(strength / 3) + 9,
    maxStamina: 2 * strength,
    maxForce: Math.floor(intelligence / 2) + Math.floor(intuition / 2) + 10,
  };
}
