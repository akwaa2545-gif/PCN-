# Popup motion and laptop layout

Updated: 2026-10-16. Local implementation only; not included in deployed `pcn-test-18-1`. Motion/dropdown verification, the 989-test unit/API run and populated Users laptop acceptance passed. A further compact Records layout at 100% browser zoom is pending.

## Interaction

Supported browsers fade native dialogs in and out over 160 ms. Create/profile dropdowns and supported native single-select pickers use 240 ms. Entry/exit movement is a small 6 px vertical shift. Native opening/closing, Escape, outside-menu dismissal, focus return and existing save/cancel actions retain their normal behavior. Closing controls become non-interactive immediately; an exit animation does not leave a hidden action available to the keyboard or pointer.

The dialog rules cover employee access, Mail Routing assignment, department timelines, Records quick view, Create dialogs/document preview, unsaved-change prompts and document-workspace dialogs. The removal confirmation overlay and supported Records disclosure panels use the 160 ms timing. The department-list disclosure itself retains its existing expand/collapse behavior.

There is no preference to configure in PCN. The operating system/browser **Reduce motion** preference removes these transitions and movement, and presentation cleanup runs immediately. Browsers without discrete-transition support retain immediate native dialog opening/closing. Create/profile dropdowns use the Web Animations API independently of that CSS support, falling back to immediate visibility when animation is unavailable. Print styles and official document typography are unaffected.

### Native selection controls

Previously unanimated single-select controls now use screen-only `appearance: base-select` and `::picker(select)` enhancement where supported. This covers Users role/department and filters, Mail Routing signing role, Create, Records and Developer selections, the formal PCN sheet's change-form/risk controls and Document Workspace upload selection. Selection remains a real native `<select>` with its existing events and validation; no JavaScript combobox replaces it. Unsupported browsers keep their native picker, and reduced motion skips picker interpolation.

In employee access, the first Escape closes an open role/department picker while retaining the outer dialog, current value and focus. [admin-users.js](../admin-users.js) checks for an open select within the dialog using a guarded selector-support check, including keyboard events whose target is an option. A subsequent Escape retains the dialog's normal close behavior.

## Implementation boundaries

The dialog, disclosure and native-picker CSS progressively enhances existing `open`, `hidden` and native `details` state through `@supports`, `@starting-style` and discrete display/overlay transitions. It does not delay requests, permissions, validation, saving or mail routing.

`PCN_UI_MOTION.setVisible` controls Create/profile presentation with a 240 ms Web Animations API animation. Logical `hidden`/`inert` state changes immediately. A temporary rendering class preserves only the non-interactive closing picture; animation completion/cancellation or a 280 ms fallback removes it. A per-element guard cancels obsolete animations when reopened. It does not mutate inline styles or depend on discrete-transition CSS support.

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

### Populated Users table

The laptop Users table keeps all nine columns and 14 px text, with compact action cells and internal horizontal scrolling instead of body overflow. Actions remain sticky and keyboard reachable. Department/status values such as **Prod.Eng/TET** and **Unavailable** fit; **Password maintenance** retains whole words. Administrator/Developer badges remain intact, while longer legacy badges may wrap.

Final populated-table visual and durable browser acceptance passed at all three laptop widths:

| Viewport width | Table width | Actions width | Filter rows |
| --- | --- | --- | --- |
| 1366 px | 1240 px | 167.45 px | 1 |
| 1280 px | 1200 px | 162 px | 1 |
| 1024 px | 1200 px | 162 px | 2 |

Ignored evidence is in `test-results/users-laptop-populated-final-visual.json` and `test-results/motion-ui-users-layout-acceptance.json`.

### Compact Records follow-up — pending

The next change targets the user's preferred compact Records appearance at **100% browser zoom**, including a visible sidebar. The proposed screen-only layout uses a 280 px sidebar/main-content pair from 1200 px upward, a roughly 64–68 px header, five filters per row, reduced padding and 13 px table text with Supplier/Material at 14 px. It uses responsive CSS rather than CSS zoom. Implementation and final visual/browser acceptance are pending; the earlier Records checks below do not establish this new density or sidebar behavior.

## Verification

The isolated [motion browser suite](../scripts/motion-ui-e2e.js), available as `npm run test:motion-ui`, passed seven groups and exited with code 0. It sampled eleven actual entry/exit fades and verified immediate logical closing/non-interactivity, retained content during exit, native Escape/focus behavior, rapid reopening and instant reduced-motion behavior. All four viewport sizes passed popup/result-list, Records, Create entry/editor and fixed-action-bar checks. Fixtures used loopback HTTP and memory storage, with zero page errors, external calls, forbidden writes or PCN mutations. The ignored report is `test-results/motion-ui-acceptance.json`.

Separate visual acceptance passed five groups with 24 captures across 1366, 1280, 1024 and 390 px widths. Its 152-element official-print comparison matched the saved baseline. A mobile Create anchor-position issue found during this work was corrected and freshly verified. The visual process exited with code 0; ignored evidence is in `test-results/motion-laptop-visual.json` and `test-results/motion-laptop-visual-mobile.json`.

The targeted helper/workspace run passed 20 tests, including five [motion-helper cases](../test/session-motion.test.js) and two [document-workspace lifecycle cases](../test/documentWorkspace.test.js). These cover immediate fallback, transition completion, bounded timeout, cancellation, stale cleanup guards and normal-close versus workspace-destruction disposal.

The native-select follow-up passed six measured picker entry/exit fades; the compatibility run passed four Create/profile fades without discrete-transition CSS. The normal motion suite retained its eleven fades across seven groups. A separate 24-capture native-dropdown visual run at 1366, 1024 and 390 px and its 152-element print comparison passed. Ignored evidence includes `test-results/motion-ui-native-select-acceptance.json`, `test-results/motion-ui-compatibility-acceptance.json` and `test-results/dropdown-native-visual.json`.

Guarded acceptance against the actual local LAN URL `http://10.249.160.21:3000/admin#users` passed role/department entry and exit, focus/value retention and outer-dialog behavior. Only an existing account's login/logout writes were allowed; business changes and operational mail were excluded. This is local LAN evidence, not deployment to `172.30.77.137`. The ignored report is `test-results/lan-users-dropdown-acceptance.json`.

The dropdown follow-up's combined unit/API suite passed 989/989 tests with 88.23% line, 91.09% branch and 94.61% function coverage. The dependency audit reported no high or critical advisories. JavaScript and general reviews approved the earlier motion changes; the accompanying development-only localhost origin fix also passed security review. Local SQL-backed readiness, an existing-account localhost login/session/logout and rejection of an unrelated origin were verified without business writes or test mail. The newer compact Records follow-up is awaiting final verification. Deployment requires a separate explicit user instruction.
