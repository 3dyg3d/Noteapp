// Design tokens from design_guidelines.json (Samsung Notes / One UI 6 vibe)

export const lightColors = {
  surface: '#FFFFFF',
  onSurface: '#1A1A1C',
  surfaceSecondary: '#F5F5F9',
  onSurfaceSecondary: '#2C2C2E',
  surfaceTertiary: '#EAEAEF',
  onSurfaceTertiary: '#3A3A3C',
  surfaceInverse: '#1A1A1C',
  onSurfaceInverse: '#FFFFFF',
  brand: '#7B8C73',
  brandPrimary: '#7B8C73',
  onBrandPrimary: '#FFFFFF',
  brandSecondary: '#A3B19B',
  brandTertiary: '#DCE3D8',
  success: '#638C61',
  warning: '#D4A352',
  error: '#B85C5C',
  info: '#6E7A8A',
  border: '#E5E5EA',
  borderStrong: '#C7C7CC',
  divider: '#E5E5EA',
  muted: '#8E8E93',
};

export const darkColors = {
  surface: '#000000',
  onSurface: '#F2F2F7',
  surfaceSecondary: '#1C1C1E',
  onSurfaceSecondary: '#E5E5EA',
  surfaceTertiary: '#2C2C2E',
  onSurfaceTertiary: '#D1D1D6',
  surfaceInverse: '#FFFFFF',
  onSurfaceInverse: '#000000',
  brand: '#8CA182',
  brandPrimary: '#8CA182',
  onBrandPrimary: '#000000',
  brandSecondary: '#687A5E',
  brandTertiary: '#3A4533',
  success: '#75A673',
  warning: '#DEB36D',
  error: '#CC6666',
  info: '#8B98A8',
  border: '#38383A',
  borderStrong: '#48484A',
  divider: '#38383A',
  muted: '#8E8E93',
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
  '#7B8C73', // sage
  '#A3B19B', // sage light
  '#D4A352', // warm
  '#B85C5C', // brick
  '#6E7A8A', // slate
  '#8B7AA8', // dusty purple (allowed as folder accent only)
  '#638C61', // moss
  '#C7C7CC', // gray
];

// Palette used for user-created labels/tags. Slightly more vivid than folder
// swatches so labels read clearly as chips on note cards.
export const labelColors = [
  '#E06C75', // coral red
  '#E5A050', // amber
  '#E6C34D', // saffron
  '#7FB86E', // meadow
  '#4EA6A6', // teal
  '#5A8CD4', // sky blue
  '#8B7AA8', // dusty purple
  '#B36AA5', // magenta
  '#6E7A8A', // slate
  '#7B8C73', // sage
];

// ---------- Accent palettes ----------
// Each accent overrides the "brand" family of colors so the app can be re-skinned
// without changing anything else. Add a new accent by supplying both a light and
// dark variant of the five brand tokens.
export type AccentKey =
  | 'sage'
  | 'blue'
  | 'purple'
  | 'rose'
  | 'amber'
  | 'ocean'
  | 'sunset'
  | 'graphite';

type BrandTokens = {
  brand: string;
  brandPrimary: string;
  brandSecondary: string;
  brandTertiary: string;
  onBrandPrimary: string;
};

export const ACCENTS: Record<AccentKey, { label: string; swatch: string; light: BrandTokens; dark: BrandTokens }> = {
  sage: {
    label: 'Sage',
    swatch: '#7B8C73',
    light: { brand: '#7B8C73', brandPrimary: '#7B8C73', brandSecondary: '#A3B19B', brandTertiary: '#DCE3D8', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#8CA182', brandPrimary: '#8CA182', brandSecondary: '#687A5E', brandTertiary: '#3A4533', onBrandPrimary: '#0F1611' },
  },
  blue: {
    label: 'Blue',
    swatch: '#5B7BC2',
    light: { brand: '#5B7BC2', brandPrimary: '#5B7BC2', brandSecondary: '#8CA5D9', brandTertiary: '#D7E1F3', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#7A97D9', brandPrimary: '#7A97D9', brandSecondary: '#4762A0', brandTertiary: '#28324F', onBrandPrimary: '#0B1224' },
  },
  purple: {
    label: 'Purple',
    swatch: '#8B7AA8',
    light: { brand: '#8B7AA8', brandPrimary: '#8B7AA8', brandSecondary: '#B4A6C9', brandTertiary: '#E4DCF0', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#A897C4', brandPrimary: '#A897C4', brandSecondary: '#6B5C87', brandTertiary: '#3A2F4E', onBrandPrimary: '#150F1F' },
  },
  rose: {
    label: 'Rose',
    swatch: '#C27BA0',
    light: { brand: '#C27BA0', brandPrimary: '#C27BA0', brandSecondary: '#DCA5C1', brandTertiary: '#F4DDEA', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#D599B8', brandPrimary: '#D599B8', brandSecondary: '#8F5578', brandTertiary: '#4E2A3E', onBrandPrimary: '#1F0E17' },
  },
  amber: {
    label: 'Amber',
    swatch: '#D4A352',
    light: { brand: '#D4A352', brandPrimary: '#D4A352', brandSecondary: '#E4C48A', brandTertiary: '#F6E9CE', onBrandPrimary: '#1A1200' },
    dark:  { brand: '#E4B970', brandPrimary: '#E4B970', brandSecondary: '#A67D39', brandTertiary: '#4F3A15', onBrandPrimary: '#1F1500' },
  },
  ocean: {
    label: 'Ocean',
    swatch: '#4A90A4',
    light: { brand: '#4A90A4', brandPrimary: '#4A90A4', brandSecondary: '#7EB2C1', brandTertiary: '#D0E4EA', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#6FA9BB', brandPrimary: '#6FA9BB', brandSecondary: '#3B7383', brandTertiary: '#213F49', onBrandPrimary: '#07151B' },
  },
  sunset: {
    label: 'Sunset',
    swatch: '#D97757',
    light: { brand: '#D97757', brandPrimary: '#D97757', brandSecondary: '#EAA48D', brandTertiary: '#F8DDCE', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#E48F71', brandPrimary: '#E48F71', brandSecondary: '#A55639', brandTertiary: '#4E2717', onBrandPrimary: '#1B0902' },
  },
  graphite: {
    label: 'Graphite',
    swatch: '#3A3A3C',
    light: { brand: '#3A3A3C', brandPrimary: '#3A3A3C', brandSecondary: '#6E6E70', brandTertiary: '#E5E5EA', onBrandPrimary: '#FFFFFF' },
    dark:  { brand: '#D1D1D6', brandPrimary: '#D1D1D6', brandSecondary: '#8E8E93', brandTertiary: '#38383A', onBrandPrimary: '#111113' },
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
