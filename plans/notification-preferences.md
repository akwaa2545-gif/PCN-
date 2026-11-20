# Configurable notification recipients

The user requested a Notifications feature in System Settings, with both department/signing-role groups and individual user choices. Six mail types are configurable: Submitted, Action required, Document updated, Completed (closed/rejected), Due soon and Overdue. Defaults preserve existing delivery until an administrator saves a change.

## Contract

`GET` and `PUT /api/admin/notification-preferences` require active Administrator or valid Developer access. GET and successful PUT return `schemaVersion:1`, the full NotificationSettings JSON SHA-256 `version`, six `rules`, safe type/group/user `options`, and saved metadata. PUT accepts only schemaVersion, version and rules. Each rule contains enabled, includeDefaultRecipients, groupKeys, userIds and excludedUserIds. Individual exclusions override the default, group and direct-user audience; direct include/exclude overlap is rejected.

Preferences are stored as a nested notificationPreferences property in the existing pcn.NotificationSettings.SettingsJson row, without a migration. Saves use the existing routing lock, current actor/admin recheck, full-row optimistic concurrency and audit, preserving mail routing and its manual contacts. Mail Routing saves must preserve preferences. Missing preferences use compatible defaults; malformed stored preferences fail closed.

## Delivery

Current Mail Routing recipients remain the action/deadline defaults. Existing eligible FYI recipients remain the informational defaults. Custom recipients must be active PCN employees with a verified directory email and actual record-read access; explicit subscriptions can include a roleless employee viewer. Recipient choices grant no signing authority. Draft saves remain silent.

Producers and pending-job claims apply current settings under the routing lock. New jobs store their notification type and recipient identities. Pending claims intersect saved identities with current eligibility and policy; new selections never add recipients to an old queued message. Disable/removal affects unsent jobs, while an in-flight delivery cannot be recalled.

Recipient batches remain limited to 30 addresses and 1,000 characters. Action/deadline batch zero keeps the existing event key; later batches use a strictly validated :batch:n suffix and snapshot index. FYI jobs retain their existing indexed update keys. Deadline membership freezes once an event has jobs, preventing reshuffled membership or revival of sent/uncertain jobs. Legacy FYI payloads lack an event type, so their saved recipients must satisfy all three informational policies rather than inferring intent from current status or email HTML. Explicit custom recipients also work for typed PCNs with legacy or uninitialized routing; those rows contribute no implicit workflow defaults. Untyped policy-1 records retain their existing explicit-action path until they adopt current routing.

## Work ownership and verification

- Backend: policy validation/selection, SQL persistence, API, Mail Routing preservation and focused unit/SQL/API tests.
- Runtime: action/FYI/deadline producers, batching, current-policy claim enforcement and regression tests.
- UI: Notifications chooser/editor, safe group/user selectors, exclusions, draft/conflict/access-loss handling and frontend tests.
- Root: asset/release wiring, integration, documentation, full checks and independent review.
- Browser: isolated Admin/Developer/denial, persistence/conflict/keyboard/mobile journeys; no live SQL, account or mail mutation.

Tests begin with failing behavioral checks. Required review covers code, JavaScript, security, SQL and accessibility. Full coverage must remain above 80%. No production preferences, mail routing or live accounts are changed during implementation or tests.

## Completed verification

- Full suite: **1,315 tests passed**, zero failures, with **89.95% line / 91.84% branch / 94.97% function coverage** (`test-results/notification-preferences-full-coverage-final.log`). Final full verification used four test processes for stable Windows execution.
- The initial full run exposed older fixtures that supplied empty jobs or omitted current settings/identity queries. Fixtures now model valid saved PCNs, routing and identities while retaining their delivery, health, uncertain-outcome, transaction-order and four-public-field assertions. Direct internal producer calls again read omitted settings under the routing lock, and absent-preference legacy error priority remains compatible. **109 targeted runtime/compatibility tests pass** (`notification-preferences-compat-focused.log`).
- **Nine isolated browser groups pass**, covering Administrator/Developer/denied access, per-type group/user/exclusion persistence, strict request validation, actual 409 handling, safe display names, keyboard/mobile controls and access-loss cleanup (`notification-preferences-browser-final.log`, `notification-preferences-report.json`). Desktop and 320px screenshots were inspected. Existing review-limit browser acceptance also passes (`notification-settings-review-limits-regression.log`).
- Independent code, JavaScript, security, SQL and accessibility reviews approve the final source. Review findings were fixed with regressions: tagged FYI claim binding, legacy automatic-recipient identity retention, malformed custom snapshots, custom recipients on legacy routing, and indexed/escaped deadline batch lookup.
- A read-only call to the actual SQL adapter returns six types, 28 department/role choices and four eligible users, with the settings row unchanged and no preferences implicitly saved (`notification-preferences-live-read.json`). Local GET checks report HTTP200 readiness and the new controller asset; anonymous preferences access returns HTTP401 (`notification-preferences-local-http.json`). No migration, configuration update, live-account change or operational mail was performed.

Run `npm run test:notification-preferences` for the isolated browser journey. Administrators open **System Settings → Notifications**, choose a role/group to edit its six subscriptions, or switch to **By notification type** for the complete audience rule, then explicitly save. Existing delivery remains in effect until that save.

## PCN role groups

The recipient picker now starts with all eight assigned PCN roles: Administrator, Developer, Reviewer, GSC, Production Engineering, QA, TaPBU and Supplier. These sit alongside the existing 28 department/signing-step groups (36 choices total). Administrator matches the actual Admin role; Developer is a distinct audience and requires the valid exclusive Developer assignment. Administrator-equivalent authorization does not make a Developer match the Administrator recipient group.

Role selections retain active-account, verified-email, record-access and individual-exclusion checks. Supplier groups receive only records they may read. Pending mail drops recipients who no longer match and never adds newly assigned role members to an existing saved recipient batch. Existing saved department choices and default delivery are unchanged.

Three new regressions failed before implementation. The focused domain/API/SQL/UI/runtime set passes **63 tests**. Nine browser groups pass with Administrator/Developer selection, exact saved keys and restored chips; desktop/320px screenshots were inspected (`test-results/notification-preferences-roles-browser-green.log`, `notification-preferences-roles-*.png`). Independent code and JavaScript reviews approve the role matching and its tests. The final full suite passes **1,318 tests**, with **89.96% line / 91.87% branch / 94.98% function coverage** (`test-results/notification-role-groups-full-coverage.log`).

## Role/group-first overview

Notifications now opens in **By role / group** mode. Choosing a PCN role or department/signing group displays all six mail types together. The primary **Current setting** column shows current recipients, workflow-dependent delivery, custom subscriptions, globally disabled types or no recipients. **Include group** is a separate additional subscription: checking a row adds only that group to that type; unchecking removes only that direct subscription. Global enable/default settings, other groups, individual inclusions and exclusions remain unchanged.

An unchecked group can still match current recipients, overlapping groups or individual rules. Current recipients remain visibly enabled when there are no additional group selections; the summary labels its enabled/default totals as system-wide. FYI defaults cover eligible internal users, with Administrator department scope and Supplier ownership restrictions. Action and deadline defaults depend on current Mail Routing, workflow assignment and review limits. Details opens the existing type editor; both views share the same draft, Save, version/CAS, Reload/discard and permission-loss handling. Switching views or selecting a group does not save or change policy. No API, persistence or delivery schema change is required.

Three group-first regressions were RED before implementation, then all **33 frontend tests passed** (`test-results/notification-group-first-red.log`, `notification-group-first-focused.log`). **Eleven browser groups pass**, including exact group-only mutations, shared views, save/reload, real conflict recovery, keyboard use, access loss and desktop/320px containment (`notification-preferences-group-first-browser-green.log`, `notification-preferences-group-first-*.png`). Source/code/JavaScript reviews approve the change. The accessibility label-in-name correction was observed failing before its fix; visible and accessible checkbox names now both contain "Include group".

The full suite passes **1,321 tests**, with **90.03% line / 91.87% branch / 95.11% function coverage** (`test-results/notification-group-first-full-coverage.log`). The final label-only accessibility correction also passes the 33 focused frontend checks. No live preferences, accounts or operational mail changed during verification.

The current-settings display follow-up passes **1,324 tests**, with **90.05% line / 91.89% branch / 95.12% function coverage** (`test-results/notification-current-settings-full-coverage.log`), plus **12 isolated browser groups** including TaPBU defaults before any custom subscription and desktop/320px containment (`notification-preferences-current-defaults-browser-green.log`). Three focused regressions failed before implementation, then all 36 frontend checks passed. Code, JavaScript and security reviews approve the completed bundle. A release extraction regression also exposed missing `pcn-types.js` and `notification-settings.js` deployment allowlist entries; both are now allowed, and all 17 release tests pass. No live preferences, accounts or operational mail changed.
