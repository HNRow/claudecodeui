# Remove Sidebar Community Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Report Issue and Join Community from every sidebar layout while preserving all other sidebar controls.

**Architecture:** Delete the two links directly from the expanded/footer component and collapsed rail, then remove imports, constants, and icon components that become unused. Add a focused component regression test; do not alter translations or the independent About-page Discord link.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, oxlint, Vite.

## Global Constraints

- Removal applies to expanded desktop, expanded mobile, and collapsed sidebar layouts.
- Settings, version branding, update notices, and restart notices remain unchanged.
- The Discord link in `src/modules/settings/tabs/AboutTab.tsx` remains unchanged.
- Do not add a setting or hide the links with CSS.
- Do not create a git commit unless the user explicitly requests one.

---

### Task 1: Remove sidebar community links

**Files:**
- Create: `src/modules/sidebar/tests/sidebarCommunityLinks.test.tsx`
- Modify: `src/modules/sidebar/SidebarFooter.tsx`
- Modify: `src/modules/sidebar/SidebarCollapsed.tsx`

**Interfaces:**
- Consumes: Existing default exports `SidebarFooter` and `SidebarCollapsed`; no props change.
- Produces: Sidebars with no accessible link named `Report Issue` or `Join Community`; all component props remain backward-compatible.

- [ ] **Step 1: Write the failing regression test**

Create `src/modules/sidebar/tests/sidebarCommunityLinks.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the test and confirm the old UI fails it**

Run:

```bash
npx vitest run src/modules/sidebar/tests/sidebarCommunityLinks.test.tsx
```

Expected: both tests FAIL because the Report Issue and Join Community links are still present.

- [ ] **Step 3: Remove links and dead supporting code**

In `src/modules/sidebar/SidebarFooter.tsx`, change the imports and constants to retain only used values:

```tsx
import { Settings, ArrowUpCircle, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import { IS_PLATFORM } from '@/shared/utils';
import type { ReleaseInfo } from '@/shared/types';

const GITHUB_REPO_URL = 'https://github.com/siteboon/claudecodeui';
```

Delete the local `DiscordIcon` function, the `GITHUB_ISSUES_URL` and `DISCORD_INVITE_URL` constants, and the four blocks labeled `Desktop Report Issue`, `Desktop Discord`, `Mobile Report Issue`, and `Mobile Discord`. Rename the layout comment:

```tsx
{/* Settings */}
<div className="nav-divider" />
```

In `src/modules/sidebar/SidebarCollapsed.tsx`, use:

```tsx
import { Settings, Sparkles, PanelLeftOpen, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';
```

Delete both URL constants, the local `DiscordIcon` function, and the complete anchors labeled `Report Issue` and `Discord`. Do not change any props or remaining controls.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
npx vitest run src/modules/sidebar/tests/sidebarCommunityLinks.test.tsx
```

Expected: 2 tests PASS, 0 failures.

- [ ] **Step 5: Run static checks and the production build**

Run:

```bash
npm run lint:client
npm run typecheck
npm run build
```

Expected: all commands exit 0. Existing warnings may remain, but there must be no new lint or TypeScript errors and the build must complete.

- [ ] **Step 6: Verify the delivered interface**

Open `http://localhost:3001` after the build. Confirm that Report Issue and Join Community are absent from the expanded sidebar and collapsed icon rail; use responsive mode to confirm the mobile sidebar. Confirm Settings still opens and update/restart indicators still appear when their existing state is active. Leave the About-page Discord link unchanged.
