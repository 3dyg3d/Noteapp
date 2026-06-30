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
