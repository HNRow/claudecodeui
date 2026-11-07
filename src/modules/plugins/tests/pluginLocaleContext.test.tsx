import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import PluginTabContent from '@/modules/plugins/PluginTabContent';

vi.mock('@/modules/plugins/context/PluginsContext', () => ({
  usePlugins: () => ({ plugins: [{ name: 'locale-fixture', enabled: true, entry: 'index.js' }] }),
}));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@/shared/api', () => ({ api: { plugins: { asset: vi.fn(async () => ({ ok: true, text: async () => 'fixture' })) } } }));

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

test('plugins receive the host locale initially and on language changes without remounting', async () => {
  const fixture = 'data:text/javascript,' + encodeURIComponent(`
    let unsubscribe;
    /** Exposes the received host context through DOM text for contract assertions. */
    export function mount(container, api) {
      container.dataset.mounts = String(Number(container.dataset.mounts || 0) + 1);
      /** Displays both initial and subscribed contexts. */
      function update(context) { container.textContent = context.locale + ':' + context.theme; }
      update(api.context);
      unsubscribe = api.onContextChange(update);
    }
    /** Releases the host subscription when the plugin unloads. */
    export function unmount() { unsubscribe?.(); }
  `);
  class PluginURL extends URL {
    /** Imports a local fixture through the host's real dynamic-import path. */
    static createObjectURL(): string { return fixture; }
    /** The fixture URL has no browser-owned blob resources to release. */
    static revokeObjectURL(): void {}
  }
  vi.stubGlobal('URL', PluginURL);
  await i18n.changeLanguage('zh-CN');
  const result = render(<PluginTabContent pluginName="locale-fixture" selectedProject={null} selectedSession={null} />);
  await waitFor(() => expect(screen.getByText('zh-CN:light')).toBeTruthy());
  const pluginContainer = screen.getByText('zh-CN:light');
  await act(() => i18n.changeLanguage('en'));
  expect(screen.getByText('en:light')).toBe(pluginContainer);
  expect(pluginContainer.dataset.mounts).toBe('1');
  result.unmount();
});
