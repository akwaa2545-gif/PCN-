# Popup motion and laptop layout

Updated: 2026-10-16. Local implementation only; not included in deployed `pcn-test-18-1`. Motion, responsive visual and targeted lifecycle checks passed; final full-suite verification is pending.

## Interaction

Supported browsers fade popups and menus in and out over 160 ms, with a small 6 px vertical movement. Native dialog opening/closing, Escape, outside-menu dismissal, focus return and existing save/cancel actions retain their normal behavior. Closing controls become non-interactive immediately; an exit animation does not leave a hidden action available to the keyboard or pointer.

The shared rules cover employee access, Mail Routing assignment, department timelines, Records quick view, Create dialogs/document preview, unsaved-change prompts and document-workspace dialogs. Account and Create dropdowns, the removal confirmation overlay and supported Records disclosure panels use the same timing. The department-list disclosure itself retains its existing expand/collapse behavior.

There is no preference to configure in PCN. The operating system/browser **Reduce motion** preference removes these transitions and movement, and presentation cleanup runs immediately. Browsers without the required discrete-transition support retain immediate opening/closing. Print styles and official document typography are unaffected.

## Implementation boundaries

The CSS progressively enhances existing `open`, `hidden` and native `details` state through `@supports`, `@starting-style` and discrete display/overlay transitions. It does not add a second application state machine or delay requests, permissions, validation, saving or mail routing.

`PCN_UI_MOTION.afterExit` in [session-client.js](../session-client.js) delays only presentation cleanup where clearing the visible content would otherwise empty a closing popup. Timeline, Mail Routing, Records preview and Create document preview invalidate their previous work and close logically first. Request/generation guards prevent a delayed callback from clearing a newly reopened popup. Access-clearing paths remove protected presentation immediately. The helper finishes on the element's opacity transition or a bounded fallback timer, and exposes cancellation; reduced motion, unsupported transitions and zero-duration styles run cleanup immediately.

[Document workspace](../document-workspace.js) dialogs defer normal DOM disposal until their exit completes. Destroying the workspace cancels pending disposals and removes its dialogs immediately, so stale cleanup cannot outlive the workspace.

## Laptop and mobile layout

The changes target common laptop viewports of **1366 × 768**, **1280 × 720** and **1024 × 768**, while retaining the existing mobile layout at **390 × 844**.

- Portal/document workspaces stack below 1440 px; wide content scrolls inside its own region instead of widening the page.
- Records filters use three columns at laptop widths, with compact spacing and contained preview scrolling.
- Create entry choices use two columns below 1200 px; the readiness panel moves below the editor below 1100 px. Short screens receive smaller vertical padding.
- Mail assignment headings/actions remain outside the scrolling editor. Employee/mail search results have a bounded height; long result lists scroll inside the popup.
- Developer tables and document-workspace dialogs retain contained scrolling. Headers/toolbars wrap when space is limited, and document dialog actions remain reachable.

The screen-only changes live in [styles.css](../styles.css), [admin.css](../admin.css), [records.css](../records.css), [create.css](../create.css), [developer.css](../developer.css) and [document-workspace.css](../document-workspace.css).

## Verification

The isolated [motion browser suite](../scripts/motion-ui-e2e.js), available as `npm run test:motion-ui`, passed seven groups and exited with code 0. It sampled eleven actual entry/exit fades and verified immediate logical closing/non-interactivity, retained content during exit, native Escape/focus behavior, rapid reopening and instant reduced-motion behavior. All four viewport sizes passed popup/result-list, Records, Create entry/editor and fixed-action-bar checks. Fixtures used loopback HTTP and memory storage, with zero page errors, external calls, forbidden writes or PCN mutations. The ignored report is `test-results/motion-ui-acceptance.json`.

Separate visual acceptance passed five groups with 24 captures across 1366, 1280, 1024 and 390 px widths. Its 152-element official-print comparison matched the saved baseline. A mobile Create anchor-position issue found during this work was corrected and freshly verified. The visual process exited with code 0; ignored evidence is in `test-results/motion-laptop-visual.json` and `test-results/motion-laptop-visual-mobile.json`.

The targeted helper/workspace run passed 20 tests, including five [motion-helper cases](../test/session-motion.test.js) and two [document-workspace lifecycle cases](../test/documentWorkspace.test.js). These cover immediate fallback, transition completion, bounded timeout, cancellation, stale cleanup guards and normal-close versus workspace-destruction disposal.

The final combined unit/API suite passed 983/983 tests with 88.23% line, 91.05% branch and 94.61% function coverage. The dependency audit reported no high or critical advisories. JavaScript and general reviews approved the motion changes; the accompanying development-only localhost origin fix also passed security review. Local SQL-backed readiness, an existing-account localhost login/session/logout and rejection of an unrelated origin were verified without business writes or test mail. Deployment requires a separate explicit user instruction.
