# PCN Records dashboard

Updated: 2026-10-15.

Status: implemented locally on `feature/records-dashboard`; deployment is on hold until the user explicitly says **deploy**. This task does not push source, publish releases, run remote CI or change the host. The last deployed runtime remains `pcn-test-17-1`; its existing evidence in [README](../README.md) and [the deployment runbook](github-deployment.md) is unchanged.

## User experience

Portal and read-only Records use the same dashboard controller and existing `records.js`/`records.css` assets. Navy/yellow branding is retained, with status text alongside colour indicators. The dashboard supports these eight improvements:

| Feature | Implemented behaviour |
| --- | --- |
| Summary cards | All records, In review, Approved and Needs attention select the corresponding list view. Counts use the accessible record set. |
| Next responsible | Displays the effective workflow department and signing step, plus eligible assigned names for internal users. Suppliers and roleless employees receive no privileged account list. |
| Workflow progress | Shows the current stage and actual recorded signing steps. A rejected record is labelled as rejected rather than presenting all signing steps as completed. |
| Filters and saved views | Combines text, status, risk, supplier, responsible department and inclusive updated-date filters. Date bounds use UTC calendar days. Up to ten named filter views can be saved or removed. |
| Open and preview | A gold **Open PCN** link beneath the PCN code opens the document in the current tab. Quick view and History use icon buttons with tooltips and accessible labels. Quick view offers read-only Overview, Timeline and Documents; Portal retains the existing history dialog. Authorized Remove is an icon under More and still requires confirmation. |
| Document readiness | Shows Documents ready, a required-document missing count, or Not available when verified metadata cannot be established. |
| Table controls | Sortable columns, configurable visible columns, 10/25/50/100 rows per page and export of the entire filtered, sorted result set as CSV. PCN code remains visible. |
| Pending time | Shows Waiting only when the current status start is recorded. Otherwise Updated identifies the saved-record timestamp fallback. Overdue requires an explicit valid review deadline. |

The preview loads data only when opened or its tab selected. Overview reads the record and progress, Timeline reads the department workflow summary, Change history reads revisions, and Documents reads attachment metadata and checks. Clean files expose existing authorized download links; quarantined, pending-scan or unknown files cannot become downloadable through the preview. No editing, signing, upload, deletion or mail action is introduced by the preview.

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

Pending time prefers a version-matched current status transition recorded in revisions. A legacy baseline does not establish when review began. If transition timing is absent, invalid or mismatched, the dashboard uses a valid saved `updatedAt` or `createdAt` and labels it as record age. Unknown timestamps remain unavailable; future timestamps do not manufacture negative waiting time.

Needs attention covers active records with missing required fields/documents, unavailable document status or a known overdue deadline. Approved, rejected and closed records are terminal and are excluded from this attention view.

The helper accepts an explicit valid `reviewDueAt` if present in a record. **The current SQL model has no persisted ReviewDueAt field or review-deadline editor.** This work introduces no deadline migration or default SLA, and does not treat `desiredStart` as a review deadline. Normal current records therefore show no inferred overdue state. Adding persisted review deadlines requires a separate product and schema change.

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
| [src/apiRoutes.js](../src/apiRoutes.js) | Authenticated overview route and employee-viewer read whitelist |
| [src/sqlDocuments.js](../src/sqlDocuments.js) | Batched live document metadata with parent versions |
| [src/sqlPcnRepository.js](../src/sqlPcnRepository.js), [src/sqlRevisions.js](../src/sqlRevisions.js) | Batched recorded current-status timing |
| [scripts/records-dashboard-e2e.js](../scripts/records-dashboard-e2e.js) | Isolated browser acceptance |

## Verification

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
