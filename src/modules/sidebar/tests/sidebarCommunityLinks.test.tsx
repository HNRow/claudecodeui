import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';

const LABELS: Record<string, string> = {
  'actions.reportIssue': 'Report Issue',
  'actions.joinCommunity': 'Join Community',
  'actions.settings': 'Settings',
};

const t = ((key: string) => LABELS[key] ?? key) as unknown as TFunction;

const assertCommunityLinksAbsent = () => {
  assert.equal(screen.queryByRole('link', { name: 'Report Issue' }), null);
  assert.equal(screen.queryByRole('link', { name: 'Join Community' }), null);
};

test('expanded sidebars omit community links and keep settings', () => {
  render(
    <SidebarFooter
      updateAvailable={false}
      restartRequired={false}
      releaseInfo={null}
      latestVersion={null}
      currentVersion="1.37.7"
      onShowVersionModal={vi.fn()}
      onShowSettings={vi.fn()}
      t={t}
    />,
  );

  assertCommunityLinksAbsent();
  assert.ok(screen.getAllByRole('button', { name: 'Settings' }).length > 0);
});

test('expanded sidebar omits the version brand link', () => {
  render(
    <SidebarFooter
      updateAvailable={false}
      restartRequired={false}
      releaseInfo={null}
      latestVersion={null}
      currentVersion="1.37.7"
      onShowVersionModal={vi.fn()}
      onShowSettings={vi.fn()}
      t={t}
    />,
  );

  assert.equal(screen.queryByRole('link', { name: /CloudCLI v/ }), null);
});

test('collapsed sidebar omits community links and keeps settings', () => {
  render(
    <SidebarCollapsed
      onExpand={vi.fn()}
      onShowSettings={vi.fn()}
      updateAvailable={false}
      restartRequired={false}
      onShowVersionModal={vi.fn()}
      t={t}
    />,
  );

  assertCommunityLinksAbsent();
  assert.ok(screen.getByRole('button', { name: 'Settings' }));
});
