# PCN document control

Updated: 2026-10-09. Document control is deployed as signed `pcn-test-12-1` from main `a5777eb9b92887b29b4f85aeb68614c79fadc294`, installed at observed host time `2026-10-09T06:11:55.8831811Z`. Migration 005 was applied earlier to `svr120a / Scn_DB`; read-only deployment checks confirmed migrations 001–005 and HTTPS SQL readiness 200. Deployment performed no DDL, account import, business-data mutation or test email. Trusted HTTPS browser acceptance passed 10 groups and 17 read-only API responses (all 200), without TLS bypass, business writes or external integration calls. See [the rollout record](github-deployment.md#acceptance-evidence).

## Editing and approvals

Save draft permits an incomplete supplier document. Submit and workflow advancement check required information and selected required attachments. The Checks tab links to missing fields. A requirement checkbox alone is not evidence of an uploaded, scanned file.

Every successful aggregate save records a snapshot and field differences in the same SQL transaction. **Save number** counts saves; **content revision** changes only when the supplier document, material identity or attachments change. Routine review comments do not change the approval digest. Existing records receive an explicitly labelled baseline on their first changed save; historical saves and unknown signer identities are not invented.

Signing records the server's user identity, date and content digest. Signed content cannot be silently replaced during review. Administrators can use **Start revision** with a reason on a nonterminal PCN; it returns to supplier action and clears active signatures while preserving earlier snapshots. Approved, rejected and closed records remain locked. Existing department/step permissions and approval order still apply.

History is read-only. The next-action panel uses the same effective route as signing and notifications, including RL0 and explicit TaPBU “No need”; it lists only active users assigned to the relevant department and step.

## Draft recovery

Editable values receive a local browser recovery copy after a short delay. Copies are scoped to the account and PCN, expire after seven days, and are limited to 250 KiB. Restore is explicit and cannot apply a copy based on an older server version. Signing checks, signer identity and dates are excluded. Recovery does not save to SQL, sign or send notifications. Storage failures appear in the UI. Confirmed saves and explicit discard remove the corresponding recovery copy without deleting newer edits.

## Attachments

The Attachments tab supports upload, selected requirement categories, scan status, clean-file preview/download and removal. Images and text preview inline; **Open PDF** offers the browser's separate PDF viewer and a download fallback because secure sandboxed frames cannot render Chromium's PDF viewer reliably. PDF, PNG, JPEG and UTF-8 text are accepted, with 10 MiB per file and 20 files / 50 MiB per PCN. Upload/removal use the current PCN version, revalidate the active actor and permissions under lock, advance the content revision and record history/audit atomically. Removal hides the file but retains its bytes for historical evidence. A retention policy remains an operational decision.

Unscanned files stay `pendingScan`, cannot be downloaded/previewed and do not satisfy required-document checks. Browser clients cannot set a trusted scan status. Signed documents require a new revision before file changes. Historical upload flags do not create files.

An optional Windows Defender adapter is included. Configure private server values `PCN_ATTACHMENT_SCANNER=windows-defender`, `PCN_ATTACHMENT_SCANNER_PATH` with the absolute official `MpCmdRun.exe` path, and `PCN_ATTACHMENT_SCAN_ROOT` with an existing local directory. Its protected Windows DACL must grant the current service SID inheritable FullControl (ContainerInherit and ObjectInherit, no propagation restriction), with other Allow entries limited to SYSTEM and BUILTIN Administrators. Ordinary user/group Allow entries are rejected. The adapter validates root ownership/permissions at startup and again for each upload, then checks child permissions before writing bytes. Do not put the scan directory under the website. The application does not change Defender policies or ACLs. Defender must be operational and executable by the service identity; do not give the web service broad administrator privileges to make scanning work. The adapter has not been tested against the real host scanner.

Uploads are scanned before database locks, using a random temporary file and a bounded 60-second process with no shell. At most two scans may run concurrently; additional requests receive a retryable busy response. Only an explicit clean result permits `clean`; detection, timeout, scanner or cleanup error rejects the upload. With the adapter disabled, uploads remain quarantined. There is no automatic rescan of older pending files. The adapter follows Microsoft's documented [custom file scan with remediation disabled](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus?view=o365-worldwide); provisioning and real clean/malware acceptance are required before enabling it in production.

## Print and PDF

**Print / PDF** verifies that the loaded saved version is current, then opens the browser print dialog. Select Save as PDF there. The original workbook layout and document font are retained. Output shows the PCN code, content revision, status and page numbers; nonterminal documents have a DRAFT watermark. Native printing with unsaved changes has an UNSAVED PREVIEW watermark. The sidebar, navigation and editing controls are excluded.

## API and database

All routes require the existing authenticated PCN access checks. Mutations also require origin/CSRF validation and a current version.

| Route | Purpose |
| --- | --- |
| GET `/api/pcns/:code/revisions` | Saved history metadata and revision capability |
| GET `/api/pcns/:code/revisions/:revision` | Immutable snapshot and differences |
| POST `/api/pcns/:code/revisions` | Administrator starts revision with `version` and `reason` |
| GET `/api/pcns/:code/checks` | Completion checklist |
| GET `/api/pcns/:code/action` | Current step and assigned users |
| GET/POST `/api/pcns/:code/documents` | Active file metadata / versioned upload |
| GET/DELETE `/api/pcns/:code/documents/:id` | Clean download / versioned soft removal |
| GET `/api/pcns/:code/documents/:id/preview` | Clean inline preview with restrictive CSP |

[Migration 005](../sql/migrations/005_document_control.sql) adds `pcn.PcnRevisions` and attachment provenance/category/removal columns. Server-owned digest and signature bindings use the existing aggregate extras. Startup expects this migration; it does not execute DDL. It is applied on `svr120a / Scn_DB`; other targets must apply reviewed migrations through `npm run db:migrate` before running this code. Back up the target and use the established migration workflow. Do not roll back the schema by deleting historical evidence.

## Local verification

`npm test` covers API/permission rules, SQL transaction fakes, revision digests, attachment security, recovery and late-edit handling. `npm run test:documents` runs the document-control journey with isolated adapters, screenshots and an actual printed PDF. `npm run test:e2e` runs the existing regression journey. These tests do not establish live SQL migration, scanner availability, email delivery or deployment acceptance.

The final local coverage run passed 444 tests with 91.08% line, 89.45% branch and 93.59% function coverage. Code and security review findings were resolved; the scanner's Windows ACL PowerShell script also passed a local syntax parse without executing it. Release CI separately passed 444 unit/API tests, 120 existing browser checks and the high/critical dependency audit gate. The host scanner remains disabled, with pending files quarantined; real scanner and live upload/save/signing/notification acceptance remain separate checks.

The document browser journey passed 13 check groups, and the existing regression journey passed 120 checks. A generated two-page PDF was rendered and inspected for the original layout, complete rows, revision/status, watermark, page numbering and handwritten signatures. The PDF attachment viewer popup and byte-exact download passed; its native plugin surface could not be visually verified in headless Chromium, so the UI retains the explicit download fallback. All browser journeys used isolated test adapters and blocked external HTTP integrations.

## Deployed browser acceptance

Trusted HTTPS Playwright checks covered existing administrator sign-in/logout, two existing records, navigation and Create PCN emphasis, Users, Mail Routing, and existing `PCN-2026-0002` History/Attachments/Checks, next action and Print control. Ten groups and 17 read-only API responses passed; the document fit a 390-pixel viewport. There were no console/page errors, business writes or external integration calls. Eleven live public assets matched the deployed commit after line-ending normalization; private configuration/source paths returned 403/404. Upload, real scanning, saving, signing, printing output and notifications were outside this live acceptance. The generated PDF and attachment viewer/download evidence above remains local.
