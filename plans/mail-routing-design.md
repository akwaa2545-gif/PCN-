# Department and signoff mail routing

Updated: 2026-10-07. The user-assignment integration below runs locally with migration 004 applied; its code deployment remains pending. The live employee-code release remains pcn-test-11-1. Automated verification of this change does not demonstrate live email delivery.

Local verification: the full coverage suite passed 283 tests, with 96.12% lines, 89.56% branches and 96.52% functions. The subsequent explicit-English-name API fix passed 19 focused API/UI tests, including an additional missing-name regression. Isolated browser verification exercised 69 checks, including user creation, duplicate-name confirmation, one-step/verified-mail requirements, assignment editing, read-only automatic recipients, conflict retention and cancellation. Code, JavaScript and security reviews completed with the signature-ancestor removal issue corrected and no remaining high/critical findings.

Migration 004 was applied on SQL Server 2014 / `Scn_DB` at `2026-10-07T04:56:51.338Z` after a DPAPI-encrypted logical snapshot of 22 tables / 145 rows was decrypted and hash-verified. This is not a native SQL backup and no full restore was exercised. All four user identities and existing role assignments were preserved; no signing grants were added and the employee source was not altered. Database readiness now reports four migrations. The local dev watcher resumed on `127.0.0.1:3000`; real API acceptance passed 26 checks and a SQL-backed headless browser passed login, Users, lookup, one-step controls, verified-mail requirement, English-name lookup and logout without account writes or page errors. Live operational mail and the new code's server deployment remain untested/pending.

## Scope and recipient model

Mail Routing separates five departments into Approved, Checked and Prepared recipient lists: **15 lists plus supplierNotification**. Each PCN user may have **one signing step** in their assigned department. Active employee-code accounts with a verified directory email become automatic recipients of that department/step list. Manual mail contacts grant no signing access. The current workbook order remains **Approved -> Checked -> Prepared**.

In Users, selecting an employee searches the mail directory using `PersonFNameEng` + `PersonLNameEng` from `KEY_Code_DB.dbo.tblEmployee`. An administrator must confirm a directory result; names alone never establish an email identity. The server revalidates the selected directory ID and email before saving. Missing English names require a manual directory search. Source employee data remains read-only and contains no email address.

The original directory flow may omit user IDs. For those results, the server supplies a stable SHA-256 selection ID derived from the normalized email; existing provider IDs are preserved. Saving still performs a fresh directory lookup and requires exactly one matching ID and email. The Users UI rejects unusable lookup results and displays validation reasons instead of silently disabling Create. A local SQL-backed browser verified that GSC/TET Approved with a confirmed ID-less mail result enables Create and reaches the submit handler; the test intercepted submission and created no account. A separate read-only check passed fresh verification against the actual directory flow. After this fix, all 288 coverage tests passed (96.13% lines, 89.58% branches, 96.52% functions), and scoped code/JavaScript/security reviews reported no high/critical findings.

Broad Administrator/Reviewer roles manage records but do not bypass signing assignments. Flags and signer metadata require the exact department and step, including clearing an existing signature. QA/TET initial and final signatures share the assignment. Final judgment and final status require QA/TET Prepared. Signer names and dates are recorded by the server when signing.

User edits atomically update roles, department, step, verified email and enabled status using `AccessVersion`; stale edits return 409. Sessions are revoked after a change, and the last active employee Administrator cannot be disabled or demoted. Migration 004 adds nullable assignment/mail-proof columns and a rowversion without assigning any existing user a step or altering previous migrations.

| Department | Approved | Checked | Prepared |
|---|---|---|---|
| GSC/TET | department.gscTet.approved | department.gscTet.checked | department.gscTet.prepared |
| Prod.Eng/TET | department.prodEngTet.approved | department.prodEngTet.checked | department.prodEngTet.prepared |
| QA/TET | department.qaTet.approved | department.qaTet.checked | department.qaTet.prepared |
| GSC/TaPBU | department.gscTapbu.approved | department.gscTapbu.checked | department.gscTapbu.prepared |
| QA/TaPBU | department.qaTapbu.approved | department.qaTapbu.checked | department.qaTapbu.prepared |

QA/TET initial review and Final Judgment reuse the same three QA/TET lists. Their stage identifiers and messages remain distinct. The supplierNotification list remains the GSC/TET supplier-communication handoff; the app does not infer a supplier recipient from the PCN.

New recipients added through the popup must be selected from directory results. Typed text is only a search query; editing a selection requires selecting a result again. Confirmation stays disabled for unavailable lookup, no match, or an unselected address. Existing saved contacts and explicit legacy copying remain available. Profiles retain safe name/email/job-title/department/inline-photo fields; directory department text is descriptive, not an authorization assignment. Lists are bounded to 30 unique addresses and 1,000 normalized email characters. This selection rule is enforced in the Add UI; the settings API contract is unchanged.

## Administrator UI

The screen keeps the compact **Mail service / badge / Check status** row, then displays five department cards with three labelled recipient sections each and a separate supplier-notification card. Contacts managed from Users are displayed separately as read-only rows; edit their assignments in Users. Existing manual contacts retain Remove and the square Add popup. QA/TET explains its review/final-judgment reuse.

Managed recipient cards and the assigned Users list display the saved verified profile photo, name, email and job/department; managed cards also identify the employee code. Only bounded inline raster photos are loaded, with initials for missing, unsafe or failed images. This presentation change passed 23 focused tests and isolated browser checks for both photo displays, initials and exclusion of managed recipients from manual saves. The final branch verification passed all 290 coverage tests (96.13% lines, 89.58% branches, 96.52% functions). No account data or routing permissions were changed.

Previous whole-department contacts appear separately as read-only **Unassigned contacts from previous routing**. An administrator can copy a legacy contact group to a selected new list; merging/deduplication does not alter the preserved legacy group or guess step membership. The 15 step lists start empty when reading old seven-group settings. Existing supplierNotification recipients are retained for the new supplier list because its key/purpose is unchanged.

**Save Mail** sends one complete versioned settings document. Unsaved edits are indicated. On 409, the editor keeps its draft and offers **Reload saved routing**; reloading requires confirmation before discarding edits. Labels identify department/action, controls and directory suggestions support keyboard use, status/errors are announced, and layouts stack on narrow screens.

Loading, directory lookup, health checks, recipient edits and routing saves do not send workflow mail. The health API remains read-only and Ready still does not prove email delivery.

## Settings API and version conflict handling

| Endpoint | Implemented contract |
|---|---|
| GET /api/notification-settings | Admin-only; schemaVersion=2, manual version, effective routingVersion, 16 groups with manual/automatic/effective contacts, seven safe legacyGroups, configured flags; no integration URLs |
| PUT/PATCH /api/notification-settings | Admin/session/origin/CSRF protected; schemaVersion=2, fetched version and all 16 groups required; duplicate/unknown/missing keys are 400; stale version is 409 |
| GET /api/admin/notifications/health | Unchanged read-only configuration/worker/queue contract |
| POST /api/pcns/:id/notifications/workflow | Compatibility path for legacy-policy records; policy-2 records return queued:false / handled_on_save rather than enqueueing again |

The request field is **version**, not a new routingVersion column or an expectedVersion JSON field. Node hashes the stored settings document; the repository locks the singleton and compares the expected hash inside its SQL transaction before saving settings, relational mirrors and audit. PUT/PATCH remain full saves, not sparse group updates. A version-1 client cannot replace stored version-2 routing: it gets 409 and must reload.

legacyGroups is server-owned and preserved from the prior settings during saves; client edits cannot overwrite it. Profiles returned by the API are sanitized/bounded. Preserving these legacy contacts is not an immutable archival/snapshot-table feature.

Automatic contacts are derived from Users and never stored in the manual settings document. Effective addresses deduplicate manual and managed contacts case-insensitively. Removing a user assignment does not delete the same address if it was saved manually. The manual `version` stays stable when user assignments change; `routingVersion` also fingerprints current managed assignments. The existing 30-address/1,000-character bounds apply to the combined list.

Account assignment writes acquire an exclusive transaction lock. PCN/settings saves and notification claims acquire the shared lock and recheck the actor's current version/security stamp, closing concurrent permission-revocation races. Notification creation reads manual settings and user assignments within the PCN transaction. At claim, pending jobs drop revoked automatic recipients while retaining manual snapshot addresses; jobs with no remaining recipients are cancelled. Already claimed, accepted and uncertain mail is not recalled or automatically retried.

PCN account activation controls automatic mail membership. Removing an employee row from the source prevents their next sign-in/session validation, but administrators must also disable their PCN account to remove its saved mail assignment. The source has no active-status column.

## Routing policy and save-time mail

The first successful **Save Mail** persists schema version 2. There is no separate activation endpoint. New PCNs created afterward select mailRoutingPolicyVersion=2 under the create transaction; existing records retain their stored policy, and an absent policy means legacy policy 1. A draft created before the settings switch remains legacy. No existing PCN is silently opted in.

For policy 2, the SQL repository calls NotificationService.prepare before persistence and NotificationService.persisted after the parent/children/audit write, all in the same transaction. The server derives the next pending stage/action from the locked saved record and existing workflow prerequisites. It snapshots recipients/payload for one handoff and returns a transient notification summary with the saved PCN. app.js displays that result and does not issue the old second enqueue POST.

| Saved transition, current order | Next recipient list |
|---|---|
| New submission or supplier resubmission | First currently pending stage/action, normally GSC/TET Approved |
| A department Approved step completes | That department Checked |
| A department Checked step completes | That department Prepared |
| A department Prepared stage completes | Next required stage Approved |
| QA/TET initial Prepared completes on RL0 | QA/TET Final Judgment Approved, using QA/TET Approved recipients |
| QA/TET final Prepared completes | supplierNotification |

A save completing several contiguous steps creates one handoff to the next pending action, not emails to steps completed in that same save. Unchanged saves, comments, approvals without signoff changes, routing edits, reloads and historical import do not create handoffs.

RL0 excludes TaPBU. For other risks, existing server routes/prerequisites remain authoritative: when a required TaPBU step is reached without tapbu.need selected, its handoff is blocked. Saving the resolved prerequisite creates a fresh eligible handoff. This does not redefine No Need as permission to bypass the server route.

The persisted mailRoutingState carries activationId, stage/action/group, settings hash and pending/blocked outcome. Its stable job EventKey is `PCN-code:activationId:handoff`. Unrelated saves preserve the current activation; a new valid handoff after invalidation gets a new activation. The unique existing EventKey and locked transaction prevent duplicate jobs for the same activation.

| Save response outcome | Meaning |
|---|---|
| notification.queued=true with jobId/status | Job committed with the PCN/audit; upstream acceptance/delivery has not occurred merely because it is queued |
| queued=false with blocked reason | Permitted PCN save succeeded, but prerequisite/recipients/mail configuration prevented queuing |
| queued=false, reason=no_transition | No new actionable handoff in this save |

Empty lists, absent/invalid mail configuration and message-validation problems persist a blocked state without failing an otherwise valid save. Editing recipients/configuration later does **not** release old blocked handoffs. Explicit blocked retry is not implemented. The known blocked reasons include recipient_not_configured, mail_not_configured, notification_configuration_invalid and tapbu_requirement_not_selected.

Signoff reset or return to supplier_action cancels only the affected **pending** job and clears/invalidates the handoff state. Sending, accepted and uncertain outcomes are not recalled or automatically retried. Status-only closure after final completion preserves an already queued supplier notice; closure does not manufacture another notice.

Legacy-policy PCNs keep whole-department manual notifications through the compatibility endpoint. Once settings are version 2, that resolver reads legacyGroups rather than the new 16 lists. Explicit legacy opt-in and legacy-contact maintenance APIs are future work.

## Existing SQL storage, no DDL

This implementation uses existing SQL2014-compatible tables. It adds no columns, migration or routing-event/snapshot table and does not alter applied migration 001.

| Existing storage | Use |
|---|---|
| NotificationSettings.SettingsJson | Version-2 groups plus preserved legacyGroups; Node computes the settings hash |
| NotificationGroups / NotificationRecipients | Transactional mirrors of the active 16 groups/profiles; legacy groups remain in SettingsJson |
| PcnRequests.LegacyExtrasJson | mailRoutingPolicyVersion and mailRoutingState; these are server-owned fields, not client-editable workflow data |
| NotificationJobs | Existing unique EventKey, recipient/payload snapshot, lease and uncertain-outcome handling |
| AuditLogs | Existing PCN/settings audit in the same transaction as relevant writes/jobs |

No immutable routing-snapshot/event table, settings rowversion column or per-PCN SQL policy column was added. Cancellation on save applies only to eligible pending jobs; worker delivery semantics and accepted-versus-delivered distinction remain unchanged.

Power Automate still receives exactly to, subject, message and senderName. The escaped HTML card names the completed action and next stage/action; QA/TET Final Judgment wording differs from initial review. Portal URL/recipients/group selection remain server-derived. Signed mail/directory endpoints stay in private server configuration. Directory request fields query/searchTerm are unchanged.

## Verification and remaining work

- [x] Local implementation of fixed 16 groups, department/action editor, legacy-copy controls, versioned full saves and conflict draft preservation.
- [x] Local save-time transactional handoff, stable activation deduplication, policy coexistence, blocked state and pending-only cancellation.
- [x] Full local tests/coverage after popup and directory-selection changes: 190/190, 95.49% lines / 88.99% branches / 95.32% functions; browser 42/42. Popup target labels, square styling, keyboard access, selection invalidation and unavailable-lookup rejection verified. Accessibility approved; local served admin.js returned 200 with separated cards, step keys and versioned Save Mail.
- [x] Final code/JavaScript edge-fix review, independent handoff checks, security and accessibility reviews approved with no findings.
- [x] Publish through main and signed CI/deployment; current pcn-test-8-1 includes this routing implementation.
- [ ] Observe a controlled live routing save and handoff/delivery separately from SSO acceptance.
- [ ] Explicit blocked-handoff retry with current-state/version revalidation and activation reuse.
- [ ] Explicit legacy-PCN opt-in and controlled legacy-contact maintenance; neither proposed endpoint exists today.
- [ ] Optional immutable routing event/snapshot history and operational reporting if required; no schema is promised by this release.
- [ ] Sender delivery/status/retry operations and cancellation policy beyond pending jobs; accepted mail cannot be recalled.

Related: [API inventory](sql-server-api-checklist.md), [table mapping](sql-server-table-mapping.md), [deployment runbook](windows-test-deployment.md).

## User assignment UI: one PCN role selector

The Users form exposes Administrator, Approved, Checked and Prepared under PCN role, with a separate PCN department. Administrator creates admin access without a signing assignment. Approved, Checked and Prepared derive the existing departmental access role (GSC/TET: gsc, Production Engineering/TET: productionengineering, QA/TET: qa, GSC/TaPBU or QA/TaPBU: tapbu) and store the selected signing step. Signing choices require explicit confirmation of a directory email; IT and Other cannot receive a signing assignment. No schema or API contract changes are required.

Existing exact role lists and signing assignments remain intact when editing mail or active status. Legacy users with no signing step display no signing assignment and retain their current access unless an administrator deliberately changes PCN role or department. Existing administrators with signing assignments show Administrator and an explanation of the preserved signing assignment. Deliberately changing PCN role or department replaces the old assignment; removal of Administrator access requires an explicit confirmation before submitting. Cancelling keeps the draft and performs no account update. Existing last-administrator and concurrency checks remain server-owned.

Verification for the four-role UI: 15 focused frontend tests passed; the full suite passed 293/293 with 96.13% line, 89.58% branch and 96.52% function coverage. Isolated browser verification passed 73 checks, including exact dropdown options, absence of duplicate signing controls, confirmed Administrator removal cancellation, preservation of multiple roles/signing on status edits, and legacy Requester editing without implicit grants. Independent code and JavaScript reviews found no actionable issues. Browser checks use isolated adapters and do not write real accounts, connect to SQL or send email.

## PCN update and action-required notifications

Policy-2 PCN saves plan two distinct messages in the existing aggregate transaction. **PCN Update** is informational and includes the current status, changed sections and a link to the PCN. Its audience is active employee-code PCN accounts with a confirmed mail-directory identity and current access to that record: internal users and that PCN's requester. Unrelated requesters are excluded. Administrator accounts do not need a signing step to receive updates. Manual signing-list contacts are not automatically subscribed to every PCN update.

**Action Required** identifies the completed action, responsible department and Approved, Checked or Prepared role that must act next. Subjects start with `[Action Required]`; informational subjects start with `[PCN Update]`. Department and role names in the email are human-readable. The existing supplier-notification handoff keeps its purpose. At a handoff, action recipients receive the action message with update context instead of a second informational message. If an action message cannot be queued, eligible account recipients can still receive the informational update.

Initial submission and meaningful changes after submission generate update mail. Ordinary draft creation/edits, metadata-only saves and unchanged saves do not. Browser defaults for missing optional blank text, unchecked flags and empty object branches do not count as changes; actual text clearing, resetting an existing checked flag, numeric values and array content/order do. A previously submitted record returned to draft can generate a status update. Ordinary edits do not repeat the action-required handoff.

General recipients are deduplicated case-insensitively and deterministically split into batches of at most 30 addresses and 1,000 recipient characters, without dropping overflow. Update event keys include the saved PCN version and batch index. The PCN, action job and every update batch commit together; a later batch failure rolls the save back. Existing `NotificationJobs` storage handles both kinds without a migration.

Before claiming an update job, the worker checks the PCN still exists and each saved recipient remains active, has access, and retains the same verified directory ID/email. Revoked recipients are dropped; newly eligible users are not added to an old snapshot. Empty jobs are cancelled. Snapshot metadata is removed before sending; Power Automate continues receiving only `to`, `subject`, `message` and `senderName`. Existing uncertain-delivery behavior remains unchanged.

Save and workflow-step notices show informational and action queue outcomes independently, including a blocked action alongside a queued update. Refreshing the record does not discard the save response's notification outcome. Queue acceptance does not claim inbox delivery. This scope covers the existing PCN aggregate/form saves and document checklist changes; attachment byte upload/delete endpoints remain separate. Historical policy-1 PCNs retain their explicit legacy notification behavior and are not converted automatically.

On 2026-10-07, the initial two test requests returned HTTP 200 from an endpoint later identified as a directory lookup flow; those responses did not establish email submission. The user supplied the actual shared-mailbox flow and explicitly authorized its existing Teams card action. Exactly one test for each notification kind was then submitted to that corrected flow for the specified test recipient; both returned HTTP 200. The user subsequently confirmed email receipt. Teams card appearance remains unverified. No automatic retries or PCN/account writes were performed. The synthetic test messages intentionally had no live PCN link.

Before activating the corrected mail endpoint, a read-only SQL check found zero pending and zero sending notification jobs. The private server configuration was backed up with its existing restricted ACL, only the mail URL was replaced, and only `SupplierPCNTest` was restarted. An initial atomic replacement failed with the original configuration intact; using explicit protected backup paths resolved it. Verified HTTPS health and SQL readiness subsequently returned 200 (`ok` and `ready`) with certificate validation enabled. The directory endpoint and other server settings were preserved. Signed trigger URLs remain outside Git. These are runtime configuration changes; the notification application changes remain local on `feature/mail-auto-mapping` pending publication/deployment.

Final application verification passed 315/315 tests with 96.29% line, 89.96% branch and 96.76% function coverage. Code, JavaScript and security reviews approved the notification changes after the no-op-save and workflow-feedback fixes. Unit/integration checks cover audience access, blank defaults versus real clears, distinct subjects/content, blocked handoffs, case-insensitive exclusion, deterministic batching, transactional rollback and recipient revocation at claim time. These automated checks use isolated adapters rather than sending operational mail or writing production accounts.

Isolated browser verification passed all 79 checks (the existing 73 plus six split-notification checks), including independent queued/blocked results, preserved workflow feedback after refresh and optimistic version updates. The browser emitted no legacy notification POST, page error or outbound email. The final browser script received independent code review approval.

## Direct PCN links in email and Teams

Real action-required and informational email templates already render an Open PCN hyperlink to `/form.html?id=<PCN code>`, derived by the server from `PUBLIC_ORIGIN`. The earlier synthetic delivery tests omitted a live PCN link. An unauthenticated reader is sent to sign-in with the original query path in `returnTo`; successful employee-code sign-in returns to that PCN. The normal server access checks still apply, and opening a link does not sign or approve a record.

The local [Teams card setup](../scripts/power-automate/README.md) is a paste-ready draft for the existing non-waiting card-post step. It keeps the four-field HTTP request contract and reuses the existing email hyperlink rather than adding new transport metadata. The flow expressions accept exactly one approved hyperlink for `https://172.30.77.137:8443/form.html?id=PCN-YYYY-NNNN`, validate the ASCII PCN code, and reconstruct that URL. A valid link produces one Open PCN action; a missing or malformed link produces no button or PCN identifier. The extraction depends on the current template markup and public origin and must be reviewed together if either changes.

Teams headings distinguish Action required from PCN updated using fixed subject prefixes. The card does not include arbitrary subject/HTML text, recipient addresses or supplier details. Existing Teams connection and destination settings are preserved; this draft does not send a private card to each email recipient or mention assigned users. The destination may have a different audience than the email list, and current PCN access controls determine who can open and act on the record.

This task made no further private configuration changes, live flow edits or message sends. Application/configuration deployment and Power Automate expression execution are separate from local verification. Localhost-generated links use the local `PUBLIC_ORIGIN`; deployment links require the recipient-accessible site origin. Do not change localhost's authentication origin to the remote site merely to alter mail links. The current draft requires the reader's existing network access to the private HTTPS server.

Direct-link regression verification passed 21 focused session/login tests and all 79 existing plus seven new isolated browser checks. Both actual email anchors were checked, sign-out revoked API access, employee-code sign-in loaded the same PCN, authorized direct opening required no second login, and another supplier received the normal 404 without record contents or editing access. No external browser request, SQL/account write or operational message was used. Teams expression acceptance and rendering remain unverified in the cloud editor.

The final full suite passed 318/318 with 96.29% line, 89.96% branch and 96.76% function coverage. Browser verification passed again after fixing temporary-server cleanup on setup and trace/context shutdown failures. Independent code and scoped security reviews approved the local tests and card draft; cloud rendering and delivery are outside that approval.
