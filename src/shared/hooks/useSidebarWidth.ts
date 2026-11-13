import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-width';
export const SIDEBAR_WIDTH_DEFAULT = 288; // the previous fixed md:w-72
/** Default for 768-1023 px viewports (phones unfolded, small tablets). */
export const SIDEBAR_WIDTH_COMPACT_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 640;
export const SIDEBAR_WIDTH_KEYBOARD_STEP = 16;

export const clampSidebarWidth = (value: number): number =>
  Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));

/** A stored width that is missing, unparseable or out of range falls back to the default. */
export const parseSidebarWidth = (raw: unknown): number => {
  // Number(), not parseInt(): the latter takes a numeric prefix, so '320px' would pass.
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_WIDTH_DEFAULT;
};

/** Returns null when the user never picked a width, so the viewport default can apply. */
const readStoredWidth = (): number | null => {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return raw === null ? null : parseSidebarWidth(raw);
  } catch {
    return null;
  }
};

/** Keeps the displayed width responsive without replacing the user's stored desktop preference. */
function subscribeViewportWidth(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** Reads the current layout viewport so rotation and window resizing recalculate the sidebar ceiling. */
function readViewportWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth;
}

/**
 * Desktop sidebar width, persisted across reloads.
 *
 * Kept out of `useUiPreferences` on purpose: that store is boolean-only
 * (`parseBoolean`, `VALID_KEYS`) and widening it to numbers would touch every
 * preference for the sake of one.
 */
export function useSidebarWidth(): {
  width: number;
  /** `persist: false` while dragging — the width is written once, on release. */
  setWidth: (value: number, persist?: boolean) => void;
  resetWidth: () => void;
} {
  // Retain the preferred desktop size while temporarily capping it on a narrower viewport.
  const [preferredWidth, setWidthState] = useState<number>(SIDEBAR_WIDTH_DEFAULT);
  const viewportWidth = useSyncExternalStore(subscribeViewportWidth, readViewportWidth, () => 0);
  const viewportCeiling = viewportWidth > 0
    ? Math.max(SIDEBAR_WIDTH_MIN, Math.floor(viewportWidth * 0.4))
    : SIDEBAR_WIDTH_MAX;
  const width = Math.min(preferredWidth, viewportCeiling);

  // Read after mount so server-side rendering and hydration see the same value.
  // Phones and foldables in their unfolded state (768-1023 px) get a narrower
  // default: the fixed 288 px rail otherwise eats a third of the screen and
  // squeezes the transcript.
  useEffect(() => {
    const stored = readStoredWidth();
    setWidthState(
      stored ?? (window.innerWidth < 1024 ? SIDEBAR_WIDTH_COMPACT_DEFAULT : SIDEBAR_WIDTH_DEFAULT),
    );
  }, []);

  const setWidth = useCallback((value: number, persist = true) => {
    const next = clampSidebarWidth(value);
    setWidthState(next);
    if (!persist) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable (private mode, quota) — the width just stops persisting.
    }
  }, []);

  // Reset clears the stored preference instead of writing 288, so the viewport
// default (288 on desktop, 240 on a folded-out phone) applies from now on.
  const resetWidth = useCallback(() => {
    try {
      window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    } catch {
      // Storage unavailable — the in-memory width still resets below.
    }
    setWidthState(
      window.innerWidth < 1024 ? SIDEBAR_WIDTH_COMPACT_DEFAULT : SIDEBAR_WIDTH_DEFAULT,
    );
  }, []);

  return { width, setWidth, resetWidth };
}
