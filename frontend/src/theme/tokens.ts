// Design tokens: One UI look (soft grey background, white cards, true-black dark).

export const lightColors = {
  // One UI: a soft grey app background with white cards on it.
  surface: '#F4F4F7',
  onSurface: '#111114',
  surfaceSecondary: '#FFFFFF',
  onSurfaceSecondary: '#1C1C20',
  surfaceTertiary: '#EAEAEF',
  onSurfaceTertiary: '#2C2C31',
  surfaceInverse: '#111114',
  onSurfaceInverse: '#FFFFFF',
  // Brand tokens are overridden by the chosen accent (ACCENTS below).
  brand: '#1F66E5',
  brandPrimary: '#1F66E5',
  onBrandPrimary: '#FFFFFF',
  brandSecondary: '#6A9AF0',
  brandTertiary: '#E7EEFC',
  success: '#2E7D32',
  warning: '#8F5B00',
  error: '#B42318',
  info: '#4B5563',
  border: '#DCDCE2',
  borderStrong: '#C7C7CE',
  divider: '#E8E8EC',
  // 6:1 on the grey background, 6.6:1 on white cards.
  muted: '#5C5C63',
};

export const darkColors = {
  surface: '#000000',
  onSurface: '#F5F5F7',
  surfaceSecondary: '#1C1C1F',
  onSurfaceSecondary: '#E8E8ED',
  surfaceTertiary: '#2C2C31',
  onSurfaceTertiary: '#D6D6DC',
  surfaceInverse: '#FFFFFF',
  onSurfaceInverse: '#000000',
  brand: '#6AA4FF',
  brandPrimary: '#6AA4FF',
  onBrandPrimary: '#000000',
  brandSecondary: '#3F6FC4',
  brandTertiary: '#1D2A44',
  success: '#6CC070',
  warning: '#F2B53C',
  error: '#FF6B5E',
  info: '#A8B0BD',
  border: '#38383D',
  borderStrong: '#48484E',
  divider: '#2C2C31',
  // 6.8:1 on dark cards.
  muted: '#A3A3AB',
};

export type AppColors = typeof lightColors;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radius = {
  sm: 8,
  md: 16,
  lg: 24,
  pill: 999,
};

export const typeScale = {
  // Compact affordances (the save pill, card metadata) ask for this size.
  xs: 11,
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const folderColors = [
  '#1F66E5', // blue
  '#0A7468', // teal
  '#2E8540', // green
  '#B04A00', // orange
  '#B42318', // red
  '#C2185B', // pink
  '#6D4CD6', // purple
  '#6B6B72', // grey
];

// Palette used for user-created labels/tags. Slightly brighter than folder
// colours so labels read clearly as chips on note cards.
export const labelColors = [
  '#E5484D', // red
  '#F08A24', // orange
  '#E0A800', // yellow
  '#46A758', // green
  '#12A594', // teal
  '#3A82F7', // blue
  '#6E56CF', // purple
  '#D6409F', // pink
  '#6B6B72', // grey
  '#8E4EC6', // violet
];

// ---------- Accent palettes ----------
// Each accent overrides the "brand" family of colors so the app can be re-skinned
// without changing anything else. Add a new accent by supplying both a light and
// dark variant of the five brand tokens.
export type AccentKey =
  | 'blue'
  | 'ocean'
  | 'purple'
  | 'rose'
  | 'amber'
  | 'sunset'
  | 'graphite';

/** Accent used when none is saved, or a saved one no longer exists (e.g. the old 'sage'). */
export const DEFAULT_ACCENT: AccentKey = 'blue';

type BrandTokens = {
  brand: string;
  brandPrimary: string;
  brandSecondary: string;
  brandTertiary: string;
  onBrandPrimary: string;
};

// Every brand colour passes 4.5:1 both as a fill under its onBrandPrimary text
// and as text on the app background, in light and dark.
export const ACCENTS: Record<AccentKey, { label: string; swatch: string; light: BrandTokens; dark: BrandTokens }> = {
  blue: {
    label: 'Blue',
    swatch: '#1F66E5',
    light: { brand: '#1F66E5', brandPrimary: '#1F66E5', brandSecondary: '#6A9AF0', brandTertiary: '#E7EEFC', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#6AA4FF', brandPrimary: '#6AA4FF', brandSecondary: '#3F6FC4', brandTertiary: '#1D2A44', onBrandPrimary: '#000000' },
  },
  ocean: {
    label: 'Teal',
    swatch: '#0A7468',
    light: { brand: '#0A7468', brandPrimary: '#0A7468', brandSecondary: '#4FA79C', brandTertiary: '#DDF1EE', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#4FC3B0', brandPrimary: '#4FC3B0', brandSecondary: '#2B7D72', brandTertiary: '#12302C', onBrandPrimary: '#000000' },
  },
  purple: {
    label: 'Purple',
    swatch: '#6D4CD6',
    light: { brand: '#6D4CD6', brandPrimary: '#6D4CD6', brandSecondary: '#9C86E8', brandTertiary: '#ECE7FB', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#B39DFF', brandPrimary: '#B39DFF', brandSecondary: '#6D58C4', brandTertiary: '#272042', onBrandPrimary: '#000000' },
  },
  rose: {
    label: 'Pink',
    swatch: '#C2185B',
    light: { brand: '#C2185B', brandPrimary: '#C2185B', brandSecondary: '#DB6F98', brandTertiary: '#FBE3EC', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#FF8AB3', brandPrimary: '#FF8AB3', brandSecondary: '#A8436B', brandTertiary: '#3A1726', onBrandPrimary: '#000000' },
  },
  amber: {
    label: 'Amber',
    swatch: '#8F5B00',
    light: { brand: '#8F5B00', brandPrimary: '#8F5B00', brandSecondary: '#C08A2A', brandTertiary: '#FBEFD6', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#F2B53C', brandPrimary: '#F2B53C', brandSecondary: '#A67A1F', brandTertiary: '#3A2A0B', onBrandPrimary: '#000000' },
  },
  sunset: {
    label: 'Orange',
    swatch: '#B04A00',
    light: { brand: '#B04A00', brandPrimary: '#B04A00', brandSecondary: '#DB7B3A', brandTertiary: '#FCE8DA', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#FF9A4D', brandPrimary: '#FF9A4D', brandSecondary: '#B86A2E', brandTertiary: '#3D2210', onBrandPrimary: '#000000' },
  },
  graphite: {
    label: 'Graphite',
    swatch: '#3A3A40',
    light: { brand: '#3A3A40', brandPrimary: '#3A3A40', brandSecondary: '#6E6E75', brandTertiary: '#E8E8EC', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#D1D1D6', brandPrimary: '#D1D1D6', brandSecondary: '#8E8E93', brandTertiary: '#2C2C31', onBrandPrimary: '#000000' },
  },
};

/**
 * Convert a `#RRGGBB` hex colour into an `rgba()` string with the given alpha.
 * Falls back to the raw colour if it isn't a 6-digit hex.
 *
 * Lived as a private helper in app/index.tsx until the drawing screen needed it
 * too; shared here rather than copied.
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const int = parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 0xff},${(int >> 8) & 0xff},${int & 0xff},${alpha})`;
}


/**
 * Colours offered for the canvas surround (the surface pages sit on).
 * Deliberately desaturated: the surround sits against the page all day, and a
 * saturated colour fights the ink.
 */
export const CANVAS_COLORS = [
  { id: 'light', label: 'Light grey', hex: '#d4d4d4' },
  { id: 'paper', label: 'Warm grey', hex: '#cfc9bf' },
  { id: 'slate', label: 'Slate', hex: '#8a8f94' },
  { id: 'graphite', label: 'Graphite', hex: '#4a4d50' },
  { id: 'ink', label: 'Near black', hex: '#1c1d1f' },
  { id: 'olive', label: 'Olive', hex: '#9aa08c' },
  { id: 'navy', label: 'Navy', hex: '#3c4658' },
  { id: 'white', label: 'White', hex: '#f5f5f5' },
] as const;
