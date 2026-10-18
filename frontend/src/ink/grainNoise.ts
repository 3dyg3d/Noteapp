/**
 * Pencil grain: a 64x64 tile of alpha values, generated the same way, byte
 * for byte, here and in the Android module (InkGrain.kt), so the wet stroke
 * drawn natively and the saved stroke drawn by Skia have identical texture.
 * Integer xorshift (no Math.random), so it is the same on every run.
 */
export const GRAIN_SIZE = 64;
/** World units per grain texel: fine compared with a 2-unit pencil line. */
export const GRAIN_SCALE = 0.4;

let cached: Uint8Array | null = null;

export function grainAlpha(): Uint8Array {
  if (cached) return cached;
  const n = GRAIN_SIZE;
  let x = 0x9e3779b9 | 0;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
  const r = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) r[i] = next();
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let xx = 0; xx < n; xx++) {
      // 3x3 average with wrap-around, so the tile repeats seamlessly.
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += r[((y + dy + n) % n) * n + ((xx + dx + n) % n)];
        }
      }
      const v = sum / 9;
      // Mean around 0.75 with strong contrast: mostly graphite, some paper.
      const a = Math.min(1, Math.max(0, 0.75 + (v - 0.5) * 3.5));
      out[y * n + xx] = Math.floor(a * 255 + 0.5);
    }
  }
  cached = out;
  return out;
}
