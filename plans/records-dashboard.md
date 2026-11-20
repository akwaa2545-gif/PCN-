# PCN Records dashboard

Updated: 2026-10-20.

The dashboard is included in deployed runtime `pcn-test-22-2`. The Prod.Eng/TET and QA/TET deadline and email additions described below are implemented locally and have not been published or deployed. Deployment remains a separate explicit user action; this feature work makes no remote or live database changes. See [the current deployment record](windows-test-deployment.md).

## User experience

Portal and read-only Records use the same dashboard controller and existing `records.js`/`records.css` assets. Navy/yellow branding is retained, with status text alongside colour indicators. The dashboard supports these eight improvements:

| Feature | Implemented behaviour |
| --- | --- |
| Document tabs | Open shows active documents. Closed groups Approved, Rejected and Closed documents while retaining their original status labels. Both tabs show counts from the authorized record set. |
| Summary cards | Open offers All open documents, In review, Drafts and Needs attention. Closed offers All closed documents, Approved, Rejected and Closed. Counts and results follow the selected tab. |
| Next responsible | Displays the effective workflow department and signing step, plus eligible assigned names for internal users. Suppliers and roleless employees receive no privileged account list. |
| Workflow progress | Shows the current stage and actual recorded signing steps. A rejected record is labelled as rejected rather than presenting all signing steps as completed. |
| Filters and saved views | Combines text, status, risk, supplier, responsible department and inclusive updated-date filters. Date bounds use UTC calendar days. Up to ten named filter views can be saved or removed. |
| Open and preview | A gold **Open PCN** link beneath the PCN code opens the document in the current tab. Quick view and History use icon buttons with tooltips and accessible labels. Quick view offers read-only Overview, Timeline and Documents; Portal retains the existing history dialog. Authorized Remove is an icon under More and still requires confirmation. |
| Document readiness | Shows Documents ready, a required-document missing count, or Not available when verified metadata cannot be established. |
| Table controls | Sortable columns, configurable visible columns, 10/25/50/100 rows per page and export of the entire filtered, sorted result set as CSV. PCN code remains visible. |
| Pending time | Shows only the duration: **1 day**, **9 days**, or **Overdue 3 days**. Time below one full day shows **<1 day**. Unknown status timing shows **—**. |

The preview loads data only when opened or its tab selected. Overview reads the record and progress, Timeline reads the department workflow summary, Change history reads revisions, and Documents reads attachment metadata and checks. Clean files expose existing authorized download links; quarantined, pending-scan or unknown files cannot become downloadable through the preview. No editing, signing, upload, deletion or mail action is introduced by the preview.

### Automatic closure and document tabs (local, 2026-10-22)

An authorized successful save automatically closes an active PCN once every eligible department and Final Judgment signature and all three top-right signatures are complete. A separate Final Judgment decision is not required for automatic closure; its existing value is preserved. Closure, any last signature, signer identity and audit revision persist together. Existing document checks, required clean files and optimistic version checks still apply. Draft saves remain drafts; normally submitting a fully completed draft may close it. Already signed active records close on their next authorized save. Opening or listing records never rewrites them, and existing Approved/Rejected/Closed records remain read-only.

The saved response opens a named **PCN closed** modal with **Continue viewing** and **View closed records**. Checkbox changes, failed saves, ordinary updates and reloads do not show that modal. Closed documents are view-only. A failed follow-up list refresh does not hide a successful saved closure.

The shared Portal/Records dashboard defaults to Open. Closed includes existing Approved and Rejected PCNs as confirmed by the user. Search, status options, summaries, pagination, CSV and printing operate within the selected tab, which remains selected during polling. Reset filters keeps the current tab. Saved views remember their tab; older terminal-status views infer Closed. `/admin?documents=closed#records` and `/records?documents=closed` open that tab directly. Keyboard navigation supports Left/Right, Home and End. Polling moves newly completed documents into Closed without rewriting their existing status labels.

### Department signing timeline (local)

The timeline now starts with a department summary. Each effective review stage shows its department, actual signatures completed out of three, and its current Prepared, Checked or Approved step. Selecting a point shows those three steps and recorded signer names/dates. QA/TET review and QA/TET Final judgment remain separate points. Counts come from saved boolean signatures, not the document's overall status; historical gaps remain visible. Draft/Supplier Action shows submission work rather than an active signing step, and incomplete terminal stages are stopped rather than falsely completed.

The route excludes TaPBU for RL0 or an explicit no-need choice. A pending TaPBU requirement displays its confirmation action. Completing all signatures remains distinct from recording the final judgment. Detailed saved changes remain available through the separate, lazy-loaded Change history tab.

`GET /api/pcns/:id/workflow-summary` derives the summary from one authorized record snapshot and returns its ID/version, effective stages, actual signing evidence and next action. It adds no database table or writes and exposes no directory assignment list, private signature binding IDs or notification data.

Timeline points use real revision metadata, recorded actors and signing changes such as GSC/TET — Checked or Approved. Cleared signatures and history baselines are identified explicitly. Missing earlier history, actors or timestamps remain unavailable rather than being invented. The existing Portal timeline continues to provide before/after details.

Preview loading, empty results, failed reads and Retry are explicit. Requests are guarded against stale responses after a tab switch, another record opening, closure or permission loss. Escape and close restore focus to the opener. The preview and table contain their scrolling at narrow viewport widths; keyboard users can navigate the preview tabs. Version checks prevent a fresh record from displaying responsibility/progress belonging to an older list snapshot.

## API and data flow

The new authenticated read-only `GET /api/pcns/overview` uses the normal API envelope. Its data payload is:

```text
{
  items: [existing full PCN record + dashboard metadata],
  generatedAt: ISO timestamp
}

dashboard:
  progress: existing workflow progress + recorded/required signing counts
  action: effective next action + permitted display names
  documents: readiness, required/completed counts, missing documents/fields
  pending: timestamp provenance, age, explicit deadline/overdue, attention reasons
```

The endpoint uses `service.list` and existing ownership/permission checks before collecting metadata. Suppliers receive only their owned records. Active verified roleless employees retain read-only access to all PCNs; `canAct` is false and assignee names are suppressed. Internal users receive only the eligible assignees' display names, not their account details or verified mail. The endpoint makes no SQL writes, invokes no directory or mail workflow and grants no new mutation permission.

Document metadata and status timing are read in validated, parameterized batches of up to 400 PCN IDs. Status timing uses SQL Server 2014-compatible `LAG` over existing revisions. Parent row-version guards accept metadata only when it matches the hydrated record; mismatches or unavailable optional metadata produce honest unknown/fallback states. Authorization errors fail closed. Missing, deleted, quarantined, pending-scan and unknown-scan files do not count as valid required documents. Required-file matching uses the existing clean-scan and requirement-category checks; it does not introduce a per-file content-revision check.

This is bulk metadata collection, not server-side pagination. Existing PCN hydration still uses its concurrency limit of four; the browser receives the accessible record set and applies filters, sort and pagination locally. Large-dataset server paging remains future work.

## Pending-time and attention rules

Pending time uses a version-matched current status transition recorded in revisions. Ordinary edits do not reset this duration; a status transition starts a new count. Status age and overdue days use server-computed whole elapsed days. When overdue, only **Overdue N days** appears; if both an explicit and a department deadline are overdue, the longest overdue duration appears once. Dates and department names remain in the review timeline. A legacy baseline or saved-record update does not establish when the current status began; unavailable status timing shows **—**. The shared table, Quick view and CSV use the same compact label.

Needs attention covers active records with missing required fields/documents, unavailable document status or a known overdue deadline. Approved, rejected and closed records are terminal and are excluded from this attention view.

The helper still accepts an explicit valid `reviewDueAt` if present in a record. The SQL model has no dedicated ReviewDueAt column or manual deadline editor; `desiredStart` never supplies a review deadline.

### Review deadlines: three calendar days after handoff

The default review window is three calendar days (72 hours, including weekends) for Prod.Eng/TET and QA/TET review, from each department's actual handoff. Prod.Eng/TET starts when all GSC/TET signatures are complete. QA/TET review starts when all GSC/TET and Prod.Eng/TET signatures are complete. The record is not overdue at the exact due instant; it becomes overdue immediately afterward.

The 2026-10-21 **System Settings** extension makes all six department-stage allowances configurable from 1–365 days or disabled, including a separate QA/TET Final Judgment rule. Prod.Eng/TET and initial QA/TET default to three days; GSC/TET, both TaPBU stages and Final Judgment default to disabled. Changes apply to ongoing reviews from their original start. Required route order determines handoffs; skipped TaPBU stages do not get clocks. See [the approved settings design](system-logic-settings.md).

The server stores each stage's start in the existing `reviewTiming` extras JSON, retaining the original Prod.Eng/TET and QA/TET keys. Stage timing itself needs no schema change; the separate configurable policy requires migration **008_workflow_settings.sql**. Starts are recorded even when a rule is disabled, so enabling it later uses the actual handoff. The normal write allowlist rejects client timing overrides. Comments, ordinary saves, and Prepared or Checked signatures preserve the original start. Completion of all three department signatures, return to an earlier stage, a revision reset, or a terminal status removes its active alert. A subsequent actual handoff starts a fresh window.

Active legacy records without a reliable saved handoff timestamp show **Due date unavailable**. Saved-record age, submission time, and old signature dates do not establish the current activation, so none is substituted. Reading an overview never starts a clock or writes data.

Portal and Records share the red overdue row, **Prod.Eng/TET overdue** or **QA/TET overdue** badge beneath the PCN code, and an accessible alert counting overdue PCNs by department in the authorized record set. The badge remains visible when the Pending time column is hidden. Department timelines show the due date and time. Pending time, its Quick view entry and CSV export show one compact duration, using the longest applicable overdue duration when both explicit and department deadlines have passed. Existing five-second refresh updates the overdue state and clears alerts after completion. Deadline bookkeeping does not create a business-update email.

### Review email notifications

The confirmed schedule retains existing handoff emails and adds one **Review Due Soon** reminder within the final 24 hours before the deadline, then one **Review Overdue** notice strictly after the deadline. There is no daily repeat. Due-soon messages use amber; overdue messages use red. Both identify the current department, pending signing step and UTC due date, and link to the PCN. Test documents retain their subject and message marker.

The configured mail worker checks for elapsed deadlines once per minute while mail is configured. It uses bounded keyset scans and the existing transactional outbox. Events deduplicate by PCN, department, trusted handoff timestamp and notification kind; edits or partial signatures cannot duplicate an event. Legacy records without reliable timing generate no deadline mail. If the server first checks after the deadline, it queues only the overdue notice.

Before sending, the worker rereads the active review and current mail configuration, resolves the pending signing step, and rebuilds recipients from its configured manual addresses and currently verified eligible account assignments. Completion, reset, deleted records, changed handoffs, missing recipients or obsolete due-soon phases cancel pending mail. Recipient changes after a committed send claim cannot recall a message already in flight. Existing uncertain delivery handling prevents automatic resend after an ambiguous transport failure. Reading the dashboard itself never queues or sends email.

## Preferences, refresh and export

Saved filter views, column selection, sort and page size use bounded browser preferences scoped to the current account. Record payloads, documents and credentials are not stored in those preferences. Malformed preferences fall back to defaults; unavailable storage leaves preferences usable for the current visit and displays a message.

Existing automatic updates read the overview while the page is visible and preserve filters, page position, focus and scrolling, including separate focus targets for the PCN code, Open PCN and More. An open preview, preference editor or row's More menu pauses background updates and invalidates already-started reads. Escape closes More and restores focus to its control. Permission loss clears records and preview data, hides the workspace and stops further polling.

CSV export includes all currently filtered records in the selected sort order and visible data columns, not just the current page. It is UTF-8 with a BOM and quoted cells; spreadsheet formula prefixes are neutralized. The output is a CSV file, not an Excel workbook or PDF report. Export changes no server data.

## Source map

| Source | Responsibility |
| --- | --- |
| [records.js](../records.js), [records.css](../records.css) | Shared dashboard, filters/preferences, table controls, preview and read-only Records initialization |
| [admin.js](../admin.js), [admin.html](../admin.html) | Portal integration, selected-detail workflow and existing authorized actions |
| [records.html](../records.html) | Read-only Records host |
| [src/recordOverview.js](../src/recordOverview.js) | Workflow, document, pending and scope-safe overview metadata |
| [src/reviewTiming.js](../src/reviewTiming.js), [src/pcnService.js](../src/pcnService.js) | Server-owned Prod.Eng/TET and QA/TET activation timing and deadline evaluation |
| [src/reviewDeadlineNotifications.js](../src/reviewDeadlineNotifications.js), [src/notificationWorker.js](../src/notificationWorker.js), [src/notificationTemplate.js](../src/notificationTemplate.js) | Deadline outbox scheduling, current recipient checks and distinct email messages |
| [src/apiRoutes.js](../src/apiRoutes.js) | Authenticated overview route and employee-viewer read whitelist |
| [src/sqlDocuments.js](../src/sqlDocuments.js) | Batched live document metadata with parent versions |
| [src/sqlPcnRepository.js](../src/sqlPcnRepository.js), [src/sqlRevisions.js](../src/sqlRevisions.js) | Batched recorded current-status timing |
| [scripts/records-dashboard-e2e.js](../scripts/records-dashboard-e2e.js) | Isolated browser acceptance |

## Verification

The 2026-10-22 automatic-closure and lifecycle-tab addition passed **1,137/1,137 unit/API tests**, with **89.05% line, 91.62% branch and 94.54% function coverage**. Tests cover route and header prerequisites, valid Final Judgment decisions, explicit draft saves, authorization, forged status changes, optimistic conflicts, required documents, transaction rollback, saved-response popup behavior, refresh failures, lifecycle filters and legacy saved views. Code, JavaScript and security reviews reported no blocking findings. Browser acceptance uses isolated memory records, with no live PCN writes or operational mail.

The final shared dashboard browser suite passed **19 groups**, including Open/Closed grouping in Portal and read-only Records, retained status labels, keyboard navigation, preserved filters and saved views, scoped CSV/print output, direct Closed links, automatic movement after polling, and desktop/390-pixel containment. Browser errors, external calls and forbidden writes were zero. Desktop and mobile Closed screenshots were inspected. Reports, traces and screenshots are under `test-results/`.

The signing-order browser suite passed **11 groups**. Its closure journey verifies that a failed save leaves the record unchanged and shows no popup; a successful final signature saves Closed and that signature in one history revision, shows the focused confirmation, hides draft saving, locks editing after dismissal/reload, and opens the Closed tab through its direct link. The run also retains the Final Judgment and header prerequisite checks. Local SQL readiness returned HTTP 200 `ready`; no migration or deployment was needed for closure.

The same-day closure correction addresses a saved Submitted record with all 12 eligible signatures and all three header checks but neither Final Judgment decision selected. Read-only inspection confirmed the additional decision requirement caused the mismatch. Automatic closure now follows signature completion alone and also handles already signed active records on their next authorized save. It preserves blank decision/date values, existing manual-status validation, required files, authorization and optimistic concurrency. Reads perform no repair writes. Regression tests first reproduced four failures, then all **66 focused tests** passed; code and security reviews approved the correction.

Final correction verification passed **1,138/1,138 tests** with **89.05% line, 91.67% branch and 94.54% function coverage**, plus **12 signing-order browser groups** with zero browser errors or external calls. The added browser case uses an already signed Submitted record, blank header dates and both decision flags false, then verifies ordinary Save closes it and shows the correct confirmation. Local SQL readiness remained HTTP 200 `ready`; the reported saved PCN was inspected read-only and was not modified by these tests.

The 2026-10-20 deadline and email addition passed all **1,050 unit/API tests** with **88.50% line, 91.40% branch and 94.66% function coverage**. The timing helper and deadline scheduler each have 100% line coverage. Tests cover both department handoffs, weekend and exact-boundary timing, HTTP authorization, SQL JSON persistence, forged timing rejection, reminder deduplication, current recipients and signing steps, stale-job cancellation and ambiguous delivery handling. Code, JavaScript and security reviews reported no blocking findings. Tests use isolated adapters; actual SQL concurrency was reviewed by inspection.

The expanded dashboard browser suite passed **17 checks** with zero browser errors, external requests or forbidden writes. It covers actual service handoffs for both departments on Portal and read-only Records, the exact 72-hour boundary, overdue onset through five-second polling, red computed colours in both department popups, mobile containment, clearing after completion, and QA review ending before final judgment. The earlier signing-order browser suite also passed on a sequential rerun after a concurrent run timed out during fixture login. The first expanded dashboard run stopped at an incorrect test expectation that final judgment would use that phrase in the department-based table label; the corrected run verifies the authoritative stage key and final-judgment timeline. Screenshots `test-results/qa-deadline-portal.png` and `test-results/qa-deadline-records-mobile.png` are isolated fixtures, not live deployment evidence.

Run the unit/API coverage and isolated browser suites from the repository root:

```powershell
npm run test:coverage
npx playwright install chromium
npm run test:records-dashboard
npm run test:e2e
npm run test:timeline
npm run test:auto-refresh
```

Focused tests cover overview ownership and roleless restrictions, unknown/quarantined metadata, parameterized batching, recorded status timing, concurrent-version guards, filters/preferences, CSV formula handling, preview lifecycle and Portal integration. Browser acceptance covers shared Portal/Records UI, supplier ownership, summary/filter/export controls, real isolated history, preview failures and stale reads, permission revocation, automatic updates and contained mobile layout. These tests use isolated adapters and make no live SQL changes or external integration calls.

Local full-suite coverage passed **682/682 unit/API tests**, with **91.92% line, 91.09% branch and 93.80% function coverage**. The final dashboard browser run passed **12 groups using 17 isolated fixture records**, with zero browser errors, external calls or forbidden writes. It covered roleless access, all summary cards, combined filters/user-scoped views, sorting/pagination/CSV, genuine document safety and progress, keyboard/lazy preview, retries/stale reads, polling, Portal/supplier scope, 390-pixel containment and overview/preview permission revocation.

Legacy read-only Records checks, timeline checks and all six automatic-update groups also passed locally. The standalone full application `npm run test:e2e` smoke suite passed with exit code 0, covering Portal, Users, mail-routing, save/authentication workflows and the existing native unsaved-change confirmation. A focused supplier probe also confirmed eight owned records and no plain Remove action, with zero browser errors, external calls or forbidden writes.

The workflow includes a dashboard browser step for a future authorized release. Adding that step is local source work; it does not mean CI or deployment has run. These local results are separate from runtime 17's release and host acceptance.

On 2026-10-15, the local table action update passed 13 isolated browser groups covering native Open navigation, read-only access, icon actions, More confirmation and polling/focus preservation, with no browser errors, external calls or forbidden writes. Open PCN uses the Create button's gold and stays beneath the PCN code. Tables use the supplied Segoe UI Semibold font, served locally as SegoeUI-Semibold.ttf and included in runtime packages. Users and PCN Records tables retain 14px text, 12px secondary text and 16px Supplier/Material values. Table text uses weight 600. The final local suite passed 964/964 tests with 88.34% line, 91.06% branch and 94.69% function coverage. The department timeline browser passed nine groups, and the shared dashboard browser passed thirteen groups, including final typography, read-only access, lazy history, keyboard/mobile behavior, authorization loss and unchanged records/revisions. Browser errors, external calls and forbidden writes were zero. Code, JavaScript and security reviews passed. This remains local work.
