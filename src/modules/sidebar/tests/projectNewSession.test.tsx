import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';

const layout = vi.hoisted(() => ({ compact: false }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => layout.compact }));

const project = { projectId: 'project-1', name: 'project', displayName: 'Project', fullPath: '/tmp/project', sessions: [] } as unknown as Project;
/** Supplies unused callbacks while exercising the real project and session-list components. */
const noop = () => {};

/** Renders a project with observable creation and expansion callbacks in either sidebar layout. */
function renderProject(compact: boolean, expanded: boolean) {
  layout.compact = compact;
  const create = vi.fn();
  const toggle = vi.fn();
  const select = vi.fn();
  return {
    ...render(React.createElement(SidebarProjectItem, {
      project, selectedProject: null, selectedSession: null, isExpanded: expanded,
      isDeleting: false, isStarred: false, isEditing: false, renameDraft: '', sessions: [],
      initialSessionsLoaded: true, isLoadingMoreSessions: false, currentTime: new Date(),
      sessionRenameId: null, sessionRenameDraft: '', tasksEnabled: false, mcpServerStatus: null,
      onRenameDraftChange: noop, onToggleProject: toggle, onProjectSelect: select,
      onToggleStarProject: noop, onStartEditingProject: noop, onCancelEditingProject: noop,
      onSaveProjectName: noop, onDeleteProject: noop, onSessionSelect: noop, onDeleteSession: noop,
      onLoadMoreSessions: noop, activeSessions: new Set<string>(), backgroundSessionIds: new Set<string>(),
      attentionSessionIds: new Set<string>(), onNewSession: create, onStartEditingSession: noop,
      onCancelEditingSession: noop, onSaveEditingSession: noop, selectedSessionIds: null,
      onSetSessionSelection: noop, onToggleSessionSelected: noop, onCancelSessionSelection: noop,
      onDeleteSelectedSessions: noop, t: ((key: string) => key) as SidebarProjectListProps['t'],
    })),
    create, toggle, select,
  };
}

for (const compact of [false, true]) {
  for (const expanded of [false, true]) {
    test(`project actions follow expansion without toggling on creation (compact=${compact}, expanded=${expanded})`, () => {
      const { getByRole, getAllByRole, queryByRole, queryByTitle, create, toggle, select } = renderProject(compact, expanded);
      if (!expanded) {
        assert.equal(queryByRole('button', { name: 'sessions.newSession' }), null);
        assert.equal(queryByTitle('tooltips.renameProject'), null);
        assert.equal(queryByTitle('tooltips.deleteProject'), null);
        return;
      }
      assert.ok(queryByTitle('tooltips.renameProject'));
      assert.ok(queryByTitle('tooltips.deleteProject'));
      const button = getByRole('button', { name: 'sessions.newSession' });
      assert.equal(button.getAttribute('title'), 'sessions.newSession');
      assert.equal(button.textContent, '', 'creation is an icon, not a full-width text action');
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.closest('button button'), null, 'the icon is not nested inside another button');
      assert.equal(getAllByRole('button', { name: 'sessions.newSession' }).length, 1);
      fireEvent.keyDown(button, { key: 'Enter' });
      fireEvent.keyDown(button, { key: ' ' });
      assert.equal(toggle.mock.calls.length, 0, 'icon keyboard events do not toggle its project');
      fireEvent.click(button);
      assert.deepEqual(create.mock.calls, [[project]]);
      assert.equal(toggle.mock.calls.length, 0);
      if (compact) assert.deepEqual(select.mock.calls, [[project]]);
    });
  }
}
