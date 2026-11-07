import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import SidebarHeader from '@/modules/sidebar/SidebarHeader';

const t = ((key: string) => key) as unknown as TFunction;

test('sidebar header omits the GitHub star badge', () => {
  const { container } = render(
    <SidebarHeader
      isPWA={false}
      isMobile={false}
      isLoading={false}
      projectsCount={0}
      runningSessionsCount={0}
      archivedSessionsCount={0}
      isArchivedSessionsLoading={false}
      searchFilter=""
      onSearchFilterChange={vi.fn()}
      onClearSearchFilter={vi.fn()}
      searchMode="projects"
      onSearchModeChange={vi.fn()}
      onRefresh={vi.fn()}
      isRefreshing={false}
      onCreateProject={vi.fn()}
      onCollapseSidebar={vi.fn()}
      t={t}
    />,
  );

  assert.equal(container.querySelector('a[href="https://github.com/siteboon/claudecodeui"]') === null, true);
});
