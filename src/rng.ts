// Small deterministic RNG (mulberry32) so shuffles are reproducible from a seed.
// The RNG state lives inside GameState, so cloned states stay deterministic.

export interface HasRng {
  rngState: number;
}

/** Advances the RNG state and returns a float in [0, 1). */
export function nextRand(s: HasRng): number {
  s.rngState = (s.rngState + 0x6d2b79f5) | 0;
  let t = s.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** In-place Fisher-Yates shuffle driven by the state's RNG. */
export function shuffle<T>(s: HasRng, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand(s) * (i + 1));
    const a = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = a;
  }
}
