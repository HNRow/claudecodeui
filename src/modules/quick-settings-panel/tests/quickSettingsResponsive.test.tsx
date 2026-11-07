import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import type * as ReactI18next from 'react-i18next';
import { afterEach, test, vi } from 'vitest';

import QuickSettingsPanelView from '@/modules/quick-settings-panel/QuickSettingsPanelView';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof ReactI18next>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', changeLanguage: async () => {} } }),
}));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({}), useSetUiPreference: () => () => {} }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: true }) }));
vi.mock('@/shared/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'codex' }));
vi.mock('@/shared/hooks/useProjectSlashCommands', () => ({ useProjectSlashCommands: () => ({ commands: [], isLoading: false, error: null }) }));

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

test('closed settings do not leave focusable controls offscreen and can be reopened', () => {
  const { queryAllByRole, getByRole } = render(<QuickSettingsPanelView selectedProject={null} />);
  assert.equal(queryAllByRole('tab').length, 0);
  fireEvent.click(getByRole('button', { name: 'quickSettings.dragHandle.openPanel' }));
  assert.ok(getByRole('tab', { name: 'quickSettings.tabs.settings' }));
  fireEvent.click(getByRole('button', { name: 'quickSettings.dragHandle.closePanel' }));
  assert.equal(queryAllByRole('tab').length, 0);
});

test('landscape and tablet widths use an overlay while retaining the desktop pin preference', () => {
  vi.stubGlobal('innerWidth', 1440);
  localStorage.setItem('quickSettingsPanel', JSON.stringify({ pinned: true, tab: 'settings' }));
  const { getByRole, queryByRole } = render(<QuickSettingsPanelView selectedProject={null} />);
  assert.ok(getByRole('button', { name: 'quickSettings.unpin' }));
  act(() => {
    vi.stubGlobal('innerWidth', 844);
    window.dispatchEvent(new Event('resize'));
  });
  assert.equal(queryByRole('button', { name: 'quickSettings.unpin' }) === null, true);
  assert.equal(JSON.parse(localStorage.getItem('quickSettingsPanel')!).pinned, true);
});
