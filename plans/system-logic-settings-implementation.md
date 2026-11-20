# System Logic Settings Implementation Plan

> For agentic workers: execute task-by-task with tests first and independent review. User approved the design and authorized implementation in this session.

**Goal:** Administrators configure pending-day limits for new and ongoing department reviews.

**Architecture:** A dedicated versioned SQL singleton stores six fixed review-stage allowances. Existing server-owned stage start times combine with the current settings at read/send time; settings saves never rewrite PCNs. A standalone System Settings page reuses Portal authentication and the existing visual language.

**Tech Stack:** Existing CommonJS Node API, SQL Server/mssql, vanilla HTML/CSS/JavaScript, node:test and isolated Playwright browser fixtures. No new dependencies.

**Spec:** [Approved design](system-logic-settings.md).

## Global constraints

- Enabled limits are whole calendar days from 1 to 365; null disables a rule.
- Defaults: prodEngTet=3, qaTet=3, gscTet/gscTapbu/qaTapbu/qaFinal=null.
- Changes apply to new and ongoing reviews without resetting start times.
- Pending time remains only a compact duration. Missing historical timing stays unknown.
- Preserve unrelated existing working-tree changes. Do not deploy or apply live migrations.

## Review focus

- Two administrators saving concurrently must get a conflict rather than silently overwrite.
- A disabled rule reenabled during a review must use the original server-recorded start.
- QA initial review and Final Judgment need separate stage identities and mail keys.
- Old queued notices must not send after changed limits, and canceled jobs must not block replacement notices.
- Legacy records must not gain invented handoff dates from ordinary edits.

## Shared interfaces

`src/workflowSettings.js` exports `RULES` (key, stageKey, department, label, defaultDays), `defaultWorkflowSettings()`, `validateWorkflowSettings(input)`, and `readWorkflowSettings(repository)`.

Settings contract: `{schemaVersion:1, version:nonnegativeInteger, pendingDays:{gscTet:null,prodEngTet:3,qaTet:3,gscTapbu:null,qaTapbu:null,qaFinal:null}, updatedAt:null|string, updatedBy:null|string}`. PUT accepts exactly schemaVersion, version and pendingDays. GET/PUT API responses additionally expose canonical `rules` definitions.

Repository methods: `getWorkflowSettings(source?)` and `saveWorkflowSettings(input, actor, user)`. SQL adapter supports reading within an existing transaction, with authoritative validation and audit on saves. Missing methods use defaults only for non-SQL isolated adapters.

Timing interfaces: `stageDeadline(record, stageKey, nowDate=new Date(), settings=defaultWorkflowSettings())`, `activeReviewDeadline(record, nowDate, settings)`, and backward-compatible `prodEngDeadline`/`qaDeadline` wrappers. Deadlines expose stageKey, department, label, startedAt, dueAt, overdue and source. `applyReviewTiming` records the current stage start even when its allowance is disabled, retaining old prodEngTet and qaTet timestamp formats.

### Task 1: Settings model, SQL and API

Files: new workflowSettings/sqlWorkflowSettings modules, migration 008, sqlDatabase/sqlPcnRepository/apiRoutes, isolated harness and new settings tests.

- [x] Write/run failing tests for defaults, exact schema, bounds, persistence, rollback/audit, admin/CSRF denial and stale saves.
- [x] Implement versioned settings repository, explicit migration/readiness and Administrator GET/PUT `/api/admin/workflow-settings`.
- [x] Run the owned unit/API tests and report the contract to integration tasks.

### Task 2: Generalized stage timing

Files: reviewTiming and its tests; compatibility assertions in reviewTimingService tests.

- [x] Write/run failing tests for all six stage handoffs, skip paths, unknown timing, disabled rules, and ongoing recalculation.
- [x] Generalize timing using required route order; preserve legacy timestamp reads and reject client timing injection.
- [x] Run timing tests and update only expectations intentionally changed by recording disabled-stage starts.

### Task 3: Admin settings interface

Files: new system-settings.html/js/css, minimal admin.html/admin.js link, static/release allowlists and frontend tests.

- [x] Write/run failing UI tests for permission gating, six labeled controls, strict day validation, save/reload and conflict handling.
- [x] Implement accessible responsive page, saved actor/time, unsaved edit protection, and Administrator-equivalent navigation visibility.
- [x] Verify asset packaging and owned frontend tests.

### Task 4: Dashboard and notification integration

Files: recordOverview/workflowSummary/apiRoutes, reviewDeadlineNotifications/server, related unit/API tests.

- [x] Write/run failing tests proving changed settings affect ongoing deadlines and both read APIs without modifying PCN clocks/signatures.
- [x] Read settings once per overview/timeline request and use current settings for scheduling and transactional mail claims.
- [x] Use stage identity plus due date in notification snapshots/deduplication; cancel obsolete jobs and allow replacement schedules.
- [x] Run integration tests, including recipient revalidation and disabled/skipped-stage cancellation.

### Task 5: Acceptance and review

- [x] Add isolated browser checks for administrator editing, reload, validation, conflict, denial, mobile layout and live deadline changes in Portal/Records.
- [x] Run full unit/API coverage and relevant browser suites sequentially when they compete for resources.
- [x] Complete code, JavaScript, security and database reviews; fix findings and rerun relevant checks.
- [x] Update existing project docs with actual verification and explicit migration/deployment requirements.

## Completed verification — 2026-10-21

The full coverage run passed **1,099/1,099 tests**, with **88.93% line, 91.53% branch and 94.53% function coverage**. The new settings model and SQL adapter each reached 100% line/function coverage; the browser settings client reached 97.78% line coverage. SQL adapter tests verify transaction rollback, current authority and simultaneous/stale saves; real concurrent SQL sessions were not exercised.

`npm run test:system-settings` passed **10 acceptance groups** using isolated memory records and real loopback authentication/API calls. It verifies six defaults, integer bounds, persisted disabling, unsaved reload decisions, stale-save preservation, active QA limits changing from 3→7→2, red row clearing/returning on normal five-second polling in both dashboards, mobile geometry/header contrast, and GET/PUT/revocation denial. Only the intended settings PUTs occurred; PCNs/revisions were unchanged and no external request, operational mail or browser error occurred. Screenshots and reports are under `test-results/system-settings-*`.

The existing Records browser suite passed **17 acceptance groups**. Its Final Judgment assertion now verifies a recorded start with the default rule disabled. A confirmed test race was corrected: automatic polling could revoke access before a manual Refresh click, so the test now directly waits for the polling-driven access clear. The first full unit run found one old assertion assuming migration 007 would remain last; it now verifies migration 007 stays in its original append-only position, and the final full run is green.

Code, JavaScript, security and database reviews have no remaining actionable findings. A security review regression covers disabling a rule, automatic cancellation, and re-enabling the same schedule: only automatically cancelled jobs with no delivery attempt can be restored; sent, sending, uncertain and manually cancelled jobs remain final. Original three-day Prod/QA notice keys retain upgrade deduplication compatibility.

## Authorized local startup repair

The user subsequently reported development-server startup failure and explicitly approved migration 008 to **SVR120A / Scn_DB**. Read-only checks first confirmed the missing table/migration, matching checksums for migrations 001–007 and required schema permissions. The narrow `applyMigrations` runner applied migration 008 without account bootstrap or master-data seeding. Before/after checks retained **9 PCNs, 10 users, 1 mail-settings row, 1 master-data version, 65 audit rows**, and identical PCN versions. The version-zero settings row contains the approved defaults. The waiting development server was restarted; `/api/ready` returned HTTP 200 `ready`, `/system-settings` returned 200 and unauthenticated settings API access returned 401 at `http://127.0.0.1:3000`.

This startup repair did not perform a signed release, protected consumer replacement, remote runtime cutover, credential change or operational mail test. Those deployment actions remain outside this implementation.

## Settings feature chooser — 2026-10-21

The user selected existing tools first: Review limits, Mail routing and User access. System Settings now opens with three feature cards. Review limits loads only after selection; the other cards open the existing Portal sections. All settings returns to the chooser with discard/cancel protection for unsaved changes and keyboard focus restored. The layout uses compact department rows, accessible field labels, responsive cards and a header that no longer covers content.

Focused frontend verification passed **18 tests** with **98.07% line coverage** for the settings client. The isolated browser suite passed **11 acceptance groups**, including desktop/mobile chooser rendering, keyboard selection, focus return, draft protection and existing validation/conflict/revocation behavior. Review confirmed the existing Admin hashes. Local readiness and the updated page returned HTTP 200. This UI follow-up made no live settings or database changes.

The subsequent visual follow-up replaces the standalone rounded-card theme with the actual PCN Records theme: shared `admin-page` typography and colors, the Records header and logo, white workspace, square bordered panels and gold actions. All three feature choices and existing review behavior remain available. Browser assertions compare computed header dimensions, logo width, typography, background and panel borders with the existing Portal Records view, and verify the square controls and shared action color.

This theme follow-up passed **18 frontend tests** and **12 browser acceptance groups**, with code/JavaScript reviews reporting no findings. A scoped automatic editor width prevents the shared full-width panel rule from clipping mobile margins; a browser bounds check verifies that inset. Updated desktop/mobile screenshots are recorded with the acceptance artifacts. The local updated page returned HTTP 200, and no live settings or database values were changed.

The review editor was subsequently made compact and grouped into TET reviews, TaPBU reviews and Final judgment. Day controls sit beside their departments, and CSS follows each native checkbox to display Enabled or No deadline immediately. The desktop detail workspace is centered and bounded, while the feature chooser retains its full Records layout. All six field IDs, labels, validation and saved timing behavior are preserved. This refinement passed **18 frontend tests** and **13 isolated browser acceptance groups**, including live status changes without saving.

On 2026-10-22 the user requested the full PCN Records layout for the review editor. The 816px workspace and 760px editor caps were removed; both settings views now use the same 1480px maximum and responsive outer margins as Records. Grouped rows and status labels remain. Isolated browser geometry checks passed at 1440px, 1920px, 390px and 320px, including all six controls staying inside the editor. This CSS-only change made no live settings or database writes.
