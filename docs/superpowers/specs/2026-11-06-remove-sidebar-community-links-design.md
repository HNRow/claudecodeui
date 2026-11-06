# Remove Sidebar Community Links

## Context

The sidebar exposes "Report Issue" and "Join Community" links in its expanded desktop and mobile layouts, and equivalent icon links in its collapsed rail. The user wants these two entries removed without affecting other sidebar functionality.

## Approach

Directly remove the links and their now-unused supporting code. CSS-only hiding would leave dead markup and behavior, while a setting would add unnecessary configuration for entries the user does not need.

## Changes

- In `src/modules/sidebar/SidebarFooter.tsx`, remove the desktop and mobile Report Issue and Discord links, the unused imports, URL constants, and local Discord icon component. Keep settings, version branding, update notices, and restart notices unchanged. Update the affected layout comment.
- In `src/modules/sidebar/SidebarCollapsed.tsx`, remove the Report Issue and Discord icon links and their unused supporting code. Keep expand, settings, update, and restart controls unchanged.
- Leave translation resources and the independent Discord link in the About settings page unchanged; they are outside the requested sidebar scope.

## Verification

Run frontend lint, the relevant client tests, and the production build. Reopen the running CloudCLI interface and verify that neither entry appears in expanded, mobile, or collapsed sidebars while settings and update controls still render.

## Assumptions

- Removal applies to every sidebar layout, not only the expanded desktop layout in the screenshot.
- The independent Discord link in the About settings page remains.
- No user-facing setting is needed to restore the removed entries.
