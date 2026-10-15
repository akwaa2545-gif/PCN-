# Create PCN experience

Status: implemented locally, 2026-10-15. This plan describes authorized local development; it does not authorize publishing, deployment, host configuration changes or operational test mail.

## Agreed experience

**Create PCN opens a dedicated page** with four stages: **Details → Changes → Documents → Review & Submit**. A readable form is the primary editing surface. The existing official PCN sheet remains the preview, print and signing document.

The page includes all seven requested improvements: live completion, inline errors, understandable upload cards, review before submission, server draft autosave and cross-device resume, a submission receipt with next responsibility and notification state, and reusable starters or existing-PCN content. **Test document** fills sample values into the normal form and creates a persistently marked **TESTING DOC**. It does not bypass validation, scanning, authorization, signing or explicit submission.

### Page layout

- Keep the existing PCN branding and account navigation. Show the PCN number after the first draft is saved, plus a clear Draft badge and save state.
- Show a horizontal step indicator on desktop and a compact current-step indicator on small screens. Each completed stage remains accessible for corrections.
- Keep the current stage's controls in one readable central column. A desktop summary shows required-item completion; on mobile the summary is a compact expandable region.
- Keep **Save draft**, **Back** and **Continue** in a persistent action bar. Only the final stage has **Submit PCN**. Opening Create, changing a stage, previewing, using a template or filling test values never submits.
- Display errors beside their fields, with field associations for assistive technology. Preserve the compact bottom-right checklist notification; it must not insert a large block above or move the form.
- Offer **Preview document** as a native modal on Create. Flush the draft, then render only the official sheet read-only in a same-origin frame, including TESTING DOC and DRAFT identity. Close or Escape restores focus to Preview document; no new tab opens.

### Stage contents

| Stage | Contents | Completion behavior |
| --- | --- | --- |
| Details | Supplier, manufacturer, material, form/change type and risk | Label required fields; explain field-specific errors when the user leaves a field or tries to continue. |
| Changes | Selected change rows, current/new conditions, reason, target start date or lot, sample choice/date, identification/location and price information | Preserve all existing conditional rules and row mappings. Keep current/new content visually paired. |
| Documents | Selected requirements and supporting file cards | Distinguish a requested document from a saved, clean attachment. Requirement selection follows existing departmental permissions. |
| Review & Submit | Read-only summaries with Edit links, official document preview, file readiness and prospective next signer | Submission remains disabled while a mutation is running; server validation is authoritative even when the live checklist is complete. |

### Start and resume

Provide **Blank PCN**, **Common change starter**, **Copy existing PCN** and **Resume draft** choices. A built-in starter selects applicable change content and leaves user-specific information for entry. Existing-PCN reuse copies a safe content projection and creates a fresh draft. No attachment bytes, approval history or signer data are reused.

The resume list contains only the signed-in user's unsigned drafts. Internal users' ability to view other records does not make another person's draft their own editable creation session. The existing record editor remains available under its current access policy.

The **Test document** action warns that the values are examples, fills the current editable form with recognizable sample content and marks it dirty. `sample()` also sets the client model's test indicator. It leaves normal required-file checks in place, creates no files, selects no signatures and sends no mail merely by filling values. Replacing existing entered values requires an explicit user action with a chance to cancel. A saved normal draft cannot be converted to a testing document; offer a fresh test draft instead.

Persist the immutable server-owned `record.isTestDocument: true` marker for test documents. Show **TESTING DOC** in the wizard, Records, the official preview and printed document, and prefix their action/update notification subjects so later explicit test submissions and signing are distinguishable. Copying a test document into another draft retains the marker. The marker survives refresh, cross-device resume, subsequent saves, submission, revisions and history; it cannot be cleared or added through ordinary record/document updates.

## Architecture and ownership

Extend the current Node/plain JavaScript application. Reuse the existing PCN aggregate, rowversions, document services, outbox and session client. No new database migration is planned.

| Owner/responsibility | Files | Boundary |
| --- | --- | --- |
| Creation model and shared checks | `create-model.js`, `pcn-readiness.js`, `src/documentChecks.js`, `src/documentRequirements.js` | Pure data/validation helpers; browser and server share readiness rules. Coordinate the shared files with the backend owner before editing. |
| Creation UI | `create.html`, `create.js`, `create.css` | Four stages, inline errors, summaries, preview, test autofill, receipt and accessible navigation. |
| Autosave controller | `create-autosave.js` | Single mutation queue, debounce, generations, canonical versions, conflict handling and recovery. |
| Creation documents | `create-documents.js` | Cards, uploads, removals and scan states using existing document APIs and the same mutation queue. |
| Backend creation worker | `src/pcnCreation.js`, `src/pcnService.js`, `src/sqlPcnRepository.js`; `src/pcnTemplates.js` and `src/notificationStatus.js` if needed | Owner-scoped draft operations, locked guards, idempotent creation, immutable test identity, preflight, safe reuse and receipt. The backend worker owns service/repository/module changes. |
| Root API, routing and runtime integration | `src/apiRoutes.js`, `src/httpServer.js`, `scripts/package-release.js`, `scripts/deploy-pcn-release.ps1` | Root owns route wiring and allowlists. Route `/create` to the new page and add every new root asset to all three allowlists. Preserve existing editor URLs. |
| Acceptance and documentation | New focused tests/browser script, `package.json`, this plan and relevant existing docs | Isolated adapters, no operational database/mail writes, local verification evidence. |

`pcn-readiness.js` is a pure UMD module usable by the browser and CommonJS. It contains the requirement catalog and completion builder. `src/documentChecks.js` keeps its public `buildChecks`, `assertCompletion` and `buildAction` interfaces, delegating readiness to the shared module. `src/documentRequirements.js` reexports the shared catalog. Preserve current labels, fields, blocking/advisory distinction, change-row handling and clean-file requirements.

## API contracts

All endpoints use the existing success/error envelope, session, role, origin/CSRF, request-size and rate-limit protections. The objects below describe the envelope's data payload. An employee with no PCN role cannot create or mutate drafts.

| Method and route | Request | Data result |
| --- | --- | --- |
| POST `/api/pcn-drafts` | `{ clientDraftKey, document, testDocument? }` | `{ record, reused }` |
| PATCH `/api/pcn-drafts/:id` | `{ version, document }` | `{ record }` |
| GET `/api/pcn-drafts` | None | Owned unsigned draft summaries; no other owner's drafts. |
| GET `/api/pcn-drafts/:id` | None | `{ record, editable, canSetRequirements, scannerConfigured }` |
| POST `/api/pcn-drafts/:id/preflight` | `{ version }` | `{ id, version, checks, nextAction, notification: { configurationStatus, recipientConfigured } }` |
| GET `/api/pcns/:id/template` | None | Safe reusable document projection after existing record-read authorization. |
| GET `/api/pcns/:id/receipt?version=hex` | None | Authorized submission identity, responsibility and safe notification states/timestamps for that version. |

Final submission uses the existing PATCH `/api/pcns/:id` with **only** `{ version, status: 'submitted' }` after all content has been saved. It does not introduce an alternative workflow transition or notification endpoint.

`testDocument` is an optional, strictly boolean outer creation parameter, separate from the document allowlist. The trusted creation service maps `true` to persisted `isTestDocument: true` in the existing aggregate extras. The client cannot write `isTestDocument` through document payloads or later PATCH requests. A normal creation has no true marker. Existing-PCN template projection includes a separate source test indicator, and copies of testing documents pass the true indicator into trusted creation.

### Atomic initial creation

1. Validate `clientDraftKey` as a UUID and derive its scope from the authenticated owner, never an owner supplied by the browser.
2. Pass the key as a trusted repository option. Persist it in existing `LegacyExtrasJson`; do not add it to general user-writable record fields.
3. In the same SQL transaction as creation, take the common exclusive creation lock before any replay scan or counter access. Then take the owner/UUID lock. Ordinary creation uses the same first lock, keeping request/counter locking in a consistent order.
4. Read that owner's candidate metadata across **all statuses**, including deleted rows, and parse JSON in JavaScript for SQL Server 2014 compatibility. A submitted record with the same key must still be found.
5. Return the existing aggregate if the key was previously committed, retaining its canonical test marker regardless of a changed replay parameter. A deleted matching record yields a conflict; it must not allocate a second identity.
6. Only an unmatched key allocates a PCN code and inserts the draft. Counter allocation, aggregate, history and audit remain atomic.

Concurrent retries and a lost initial response therefore return the original PCN. A recovered response can contain newer canonical content; the client adopts its identity/version and retains any later local edits for a subsequent versioned save.

### Locked draft mutation

`PcnCreationService` validates the content projection and calls `PcnService.update` with a trusted `draftOnly` option. The owner check, `status === 'draft'` check and unsigned check run **inside the repository's locked updater**, before applying content. A separate read followed by the ordinary update is insufficient: another session could submit or sign between those operations.

The endpoint cannot write status, ownership, signatures, signer names/dates, approval decisions, routing/mail state, history or document-control metadata. Authorized requirement/material identity changes follow the same existing `canEditReview` policy. A rowversion conflict pauses saving and requires a deliberate recovery/reload choice. A record that has become submitted, signed or terminal is no longer a wizard draft.

### Preflight and templates

Preflight checks the saved version after the mutation queue has drained, reads actual attachment metadata, evaluates shared completion and computes responsibility for the prospective **submitted** record. Existing `/action` on a draft reports preparation responsibility, so it cannot be used unchanged as the prospective signer. Preflight performs no update, outbox enqueue or mail call; final submission repeats the authoritative validation.

Existing-PCN reuse uses an explicit field allowlist. Strip every review section by default. Only document requirement flags and material code/description may be projected when the current user is authorized to set them. Never copy supplier/internal signatures, judgment, review comments, attachments, revision/binding metadata, identities or routing state. Retain the source's true test indicator outside the reusable document projection; this indicator does not grant access to other metadata. The result is normalized and remains subject to normal server authorization. Built-in starters and test autofill are client model data, not trusted server bypasses.

## Autosave and document coordination

Use one mutation queue for initial creation, draft saves, uploads, removals and submission. Debounce content edits, coalesce unsent snapshots, and never have competing writes for the same browser session. Keep a generation number so an earlier response cannot mark later edits saved or replace them.

Before upload, flush the current document into its saved draft. Upload with that canonical version, then adopt the upload result's new record/version before another operation. Removal follows the same rule. Do not reuse an old version after a file mutation.

Save states are **Unsaved**, **Saving**, **Saved at [time]**, **Offline** and **Needs attention**. Failures retain form content and local recovery. Recovery is scoped to account and PCN/client draft key; it cannot overwrite a newer server version or restore signatures. Cross-device continuation loads server content, not another browser's local recovery store.

A submission click drains the queue, saves the latest generation, runs preflight, and sends one explicit status update. Duplicate clicks share the in-flight operation. After a lost submission response, GET the canonical record: if it has left draft, recover the receipt; do not automatically resubmit. If it remains draft, explain the outcome and require a fresh explicit submission attempt.

## File and notification semantics

File cards use actual saved metadata. A required checkbox means the document is requested; it does not mean a file exists. Only a nondeleted clean file for that requirement satisfies completion. Preserve current file type/size/total limits, scan trust, role checks and revision behavior.

The current scanner runs synchronously when configured. While an upload request is awaiting that scan, the UI can show Scanning. Without the trusted scanner, files remain `pendingScan`; there is no background rescan path. Show **Awaiting scan — scanning unavailable** with an understandable explanation rather than promise automatic completion. Do not provision a scanner, modify Defender/ACL policy or mark a file clean as part of this UI work.

The receipt reads the relevant action job for the submission version/activation, not the newest unrelated job or all update-notification batches. It must not expose recipient addresses, raw payloads, integration URLs, tokens or raw internal errors. Map `pending`/`sending` to Queued/Processing, `sent` to **Accepted by workflow**, and uncertain/blocked outcomes to **Needs attention**. Workflow acceptance is not proof of mailbox delivery. Preserve distinct cancelled or superseded states when the next responsibility has changed. Bounded status polling is read-only and must never requeue by resubmitting.

## Incremental implementation and verification

1. Write focused regression tests for shared readiness, template sanitization, draft guards, idempotency, receipt projection and mutation coordination. Run RED before implementation; the root agent manages the required checkpoint.
2. Implement shared model/check extraction and backend contracts. Keep legacy endpoint behavior intact. Prove locked guards and lost-response/concurrent initial creation with isolated SQL adapters.
3. Implement the dedicated page, four stages, required-item count and inline/bottom-right errors. Verify that Create no longer opens the official sheet as its primary entry form.
4. Connect autosave/resume, then document cards using the shared mutation queue. Add preflight/review and explicit submission receipt.
5. Add safe starters, existing-PCN reuse and test autofill, including immutable test identity, **TESTING DOC** badges in wizard/Records/official preview/print and notification prefixes. Add new assets to all runtime allowlists and extend release artifact tests.
6. Run focused GREEN tests, complete coverage and sequential isolated browser acceptance. Obtain JavaScript, code and security reviews for the final changes. Record evidence in existing project docs before the local completion checkpoint.

### Unit and integration coverage

- Readiness parity for unsaved/saved content, conditional sample dates, per-change-row values, requirement categories and pending/deleted files.
- Template projection with malicious extra keys and records containing every signing, final-decision, revision and routing field.
- Inactive/view-only/other-owner access; CSRF/origin protection; bad UUID, malformed document/version, unsupported fields and oversized input.
- Parallel creation, lost POST response, same key after submission and deleted-key conflict without duplicate counters, aggregates or outbox jobs.
- Strict outer test-parameter validation; direct or nested marker injection rejected; canonical marker retained on key replay; normal drafts cannot be converted, and test drafts cannot be unmarked by autosave, normal update or revision operations.
- Test source projection and reuse retain true identity while clearing all signing/mail data; test action and update notices receive the distinguishing prefix without changing recipients, workflow order or normal validation.
- Signed/submitted records racing an autosave; owner guard under lock; 409 conflict; no automatic workflow changes or draft mail.
- Mutation serialization, edits during requests, stale response generations, upload version adoption, offline recovery and lost submission reply handling.
- Receipt limited to an authorized PCN and requested version, correct action job selection, safe states and no recipient/payload/error leakage.
- Static routing and all new assets included in both producer and consumer release allowlists.

### Browser acceptance

- Blank, common starter, existing-PCN reuse and owned draft resume, with two browser contexts for cross-device continuation and conflict behavior.
- Live required-item progress, field errors, keyboard focus targets and bottom-right notifications without shifting layout.
- All four stages, Edit links from Review, official sheet preview/print, small-screen layout and keyboard-only navigation.
- Test autofill produces ordinary editable example data with **TESTING DOC**, no automatic files, signatures, submission or mail. Refresh and second-device resume retain the badge; normal validation and required clean attachments still block submission when incomplete.
- Copying a testing source retains the badge; a saved normal draft offers creation of a fresh testing draft rather than conversion. Records, official preview, print and subsequent action/update notifications clearly distinguish the test document.
- Upload/remove flow with clean, pending and unavailable scanner adapters; real current-version changes; normal required-document blocking.
- Explicit submission, exact next signer, queued/accepted/attention receipt states, double-click suppression and lost-response recovery.
- Existing `/form.html?id=…` and PCN paths still edit/sign/print normally; Prepared → Checked → Approved, historical signatures, document revisions and existing recovery remain correct.

Tests use memory/fake SQL and loopback browser servers with fake integrations. They must not exercise operational SQL writes, real Power Automate mail, push, remote CI, SSH or deployment.

## Completion criteria

- [x] Create opens the dedicated four-stage page; existing signing and official sheet paths remain functional.
- [x] All seven requested features and the normal-validation Test document autofill are implemented.
- [x] Test documents persist immutable test identity, retain it through replay/reuse/resume and display **TESTING DOC** in the wizard, Records, official preview/print and distinguishing notification prefixes.
- [x] Draft creation is atomically idempotent and autosave cannot change a signed/submitted/other-owner record.
- [x] Autosave, uploads and submission share canonical versions and preserve newer local edits.
- [x] Reuse creates a fresh document without signatures, history, mail state or copied files.
- [x] Readiness and inline errors match server rules; scan-unavailable files never appear Ready.
- [x] Receipt accurately reports next responsibility and workflow acceptance without claiming delivery or exposing private mail data.
- [x] Relevant tests, browser regressions, release checks and reviews pass; verification evidence is recorded.
- [x] No deployment occurs until the user explicitly requests it.


## Local verification ? 2026-10-15

- Full unit/API coverage run: **860/860 passed**, with **88.10% lines, 90.93% branches and 95.11% functions** (`node --test --experimental-test-coverage --test-concurrency=4`). Evidence: `test-results/create-final-coverage.log`.
- Create browser acceptance: **13 journeys**, plus focused 350/390px layout, initial-save retry and old-client copy/starter identity checks. All use isolated synthetic records, scanner metadata and captured outbox jobs; no external requests, real SQL writes or operational mail. Evidence: `test-results/create-pcn-*-final.log` and acceptance JSON/trace files.
- Existing browser regressions: smoke **120**, documents **13**, signing order **8**, Records **12**, login **8** checks/groups passed. The Records fixture was aligned with the current unsigned Prepared responsibility; historical signatures and privacy assertions remain unchanged.
- Windows release packaging/extraction checks: **11/11 passed**, including all creation assets and private-file exclusions.
- Code, JavaScript and security reviews approved the implementation. Follow-up regressions cover in-flight edits, stale entry/receipt responses, readonly requirements, document note/caret preservation, fresh testing/copy identities and consistent SQL creation lock order.
- Local readiness returned `ready`. No migration, push, deployment, private configuration change or operational notification was performed.


## Follow-up: document-only popup preview

The dedicated `/document-preview?id=...&version=...&request=...` route reuses the official form renderer. It verifies the exact saved identity/version and forces read-only mode before loading; it skips profile, workspace, recovery, record-list reads and polling. Only this exact GET/HEAD route permits same-origin framing; normal pages and APIs retain DENY and frame-ancestors none. The parent accepts readiness/errors only from its own frame, origin and matching per-open request. Loading/error content stays hidden, and closing or errors invalidate stale messages. Focused desktop/mobile popup checks and the full Create browser suite pass with no operational SQL or mail.

Follow-up verification: **878/878 unit/API tests passed**, with **87.68% line, 90.99% branch and 95.12% function coverage**. Focused popup desktop/mobile checks pass, including error/late-ready handling, and the updated full Create suite passes 14 journeys. Evidence: `test-results/preview-developer-final-coverage.log`, `create-pcn-preview-final.log` and `create-pcn-browser-final.log`. Code, JavaScript and security reviewers approved the changes.
