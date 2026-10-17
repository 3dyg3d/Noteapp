import type { PageSetup } from '@/src/state/useAppSettings';

/** Used until the user has picked paper once. */
export const DEFAULT_PAGE_SETUP: PageSetup = {
  paper: 'blank',
  paperSize: 'a4',
  orientation: 'portrait',
  paperColor: '#FBFAF6',
};

/**
 * The drawing_data of a brand-new handwritten note. Every field the editor
 * reads is written explicitly, so a new note never inherits settings from the
 * note that was open before it.
 */
export function newHandwritingDoc(setup: PageSetup | null | undefined, canvasColor: string): string {
  const s = { ...DEFAULT_PAGE_SETUP, ...(setup || {}) };
  return JSON.stringify({
    paper: s.paper,
    paperSize: s.paperSize,
    customSize: s.paperSize === 'custom' ? s.customSize : undefined,
    paperColor: s.paperColor,
    orientation: s.orientation,
    lineSpacing: s.lineSpacing,
    canvasColor: canvasColor || '#d4d4d4',
    pageCount: 1,
    docVersion: 3,
    items: [],
  });
}
