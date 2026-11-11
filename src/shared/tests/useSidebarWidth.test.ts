import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import {
  SIDEBAR_WIDTH_COMPACT_DEFAULT,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  parseSidebarWidth,
  useSidebarWidth,
} from '@/shared/hooks/useSidebarWidth';

test('the sidebar width is clamped to the supported range', () => {
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 100), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(320), 320);
  assert.equal(clampSidebarWidth(320.6), 321);
});

test('a wide sidebar adapts to the viewport and restores the preferred width after expanding', () => {
  localStorage.setItem('sidebar-width', '640');
  vi.stubGlobal('innerWidth', 1440);
  try {
    const { result } = renderHook(() => useSidebarWidth());
    assert.equal(result.current.width, 576);
    act(() => {
      vi.stubGlobal('innerWidth', 768);
      window.dispatchEvent(new Event('resize'));
    });
    assert.equal(result.current.width, 307);
    assert.equal(localStorage.getItem('sidebar-width'), '640', 'resizing must not overwrite the user preference');
    act(() => {
      vi.stubGlobal('innerWidth', 1920);
      window.dispatchEvent(new Event('resize'));
    });
    assert.equal(result.current.width, 640);
  } finally {
    vi.unstubAllGlobals();
    localStorage.removeItem('sidebar-width');
  }
});

test('a stored width is restored, and a broken one falls back to the default', () => {
  assert.equal(parseSidebarWidth('420'), 420);
  assert.equal(parseSidebarWidth('9999'), SIDEBAR_WIDTH_MAX);
  assert.equal(parseSidebarWidth('10'), SIDEBAR_WIDTH_MIN);
  assert.equal(parseSidebarWidth(null), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(parseSidebarWidth('wide, please'), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(parseSidebarWidth(undefined), SIDEBAR_WIDTH_DEFAULT);
  // A numeric prefix is not a width: '320px' is as broken as 'wide, please'.
  assert.equal(parseSidebarWidth('320px'), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(parseSidebarWidth(''), SIDEBAR_WIDTH_DEFAULT);
});

test('the default width matches the previous fixed sidebar', () => {
  assert.equal(SIDEBAR_WIDTH_DEFAULT, 288); // md:w-72
});

test('an unfolded phone viewport starts from the narrower default', () => {
  // 820 px is the unfolded inner screen of a foldable phone: the 288 px rail
  // leaves too little room for the transcript.
  localStorage.removeItem('sidebar-width');
  vi.stubGlobal('innerWidth', 820);
  try {
    const { result } = renderHook(() => useSidebarWidth());
    assert.equal(result.current.width, SIDEBAR_WIDTH_COMPACT_DEFAULT);
  } finally {
    vi.unstubAllGlobals();
  }
});
