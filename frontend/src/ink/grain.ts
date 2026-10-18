import { AlphaType, ColorType, Skia, SkImage } from '@shopify/react-native-skia';

import { GRAIN_SIZE, grainAlpha } from './grainNoise';

export { GRAIN_SIZE, GRAIN_SCALE } from './grainNoise';

const images = new Map<string, SkImage | null>();

/** The grain tile in a given colour (colour in RGB, grain in alpha). Cached. */
export function grainImage(color: string): SkImage | null {
  if (images.has(color)) return images.get(color)!;
  const c = Skia.Color(color); // RGBA floats 0..1
  const a = grainAlpha();
  const n = GRAIN_SIZE;
  const bytes = new Uint8Array(n * n * 4);
  const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255);
  const ca = c[3];
  for (let i = 0; i < n * n; i++) {
    bytes[i * 4] = r;
    bytes[i * 4 + 1] = g;
    bytes[i * 4 + 2] = b;
    bytes[i * 4 + 3] = Math.round(a[i] * ca);
  }
  const img = Skia.Image.MakeImage(
    { width: n, height: n, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
    Skia.Data.fromBytes(bytes),
    n * 4
  );
  images.set(color, img);
  return img;
}
