# Supplier PCN workflow — SQL Server

Updated: 2026-10-15.

The Node API stores PCN form data, internal review, comments, approvals, audit history, routing settings and application accounts in SQL Server. The browser calls the API; the active application does not use Firebase Authentication or Firestore. The existing target is `svr120a / Scn_DB`.

Employee-code-only login is backed by read-only `[KEY_Code_DB].[dbo].[tblEmployee]` on the same `svr120a` server. An employee in that source receives a roleless PCN account on first sign-in. A source-verified active employee with no assigned role can browse all PCNs through the read-only Records page, including record details, history, checks and available attachment downloads/previews. Administrators assign PCN roles, departments and signing permissions in Users to enable actions under existing permission and ownership rules. The employee source is not imported or modified. These changes are deployed in signed `pcn-test-13-1`. See [the employee-code plan](plans/employee-code-authentication.md) for the source model and historical deployment evidence.

Users separates **Add role** (find an employee or existing account and assign access) from **Create user** (enter a seven-digit employee code and full name, then select role, department and verified mail). Administrators can create an employee missing from the source as a `pcn-local` account in the PCN database. These accounts use the same employee-code-only login, with current PCN account/session checks; source-backed employees retain source verification. Creation requires a successful source-absence check and rejects duplicate codes or source outages. Signing mail remains directory-verified and follows the existing Power Automate workflow. See [the local-account plan](plans/pcn-local-users.md).

Users are grouped into **Pending access** (no assigned roles, marked with a yellow indicator) and **Assigned PCN users**. Shared name/code/email, PCN role, department and account-status filters apply to both groups. **Remove role** confirms removal of all PCN grants while keeping the account, identity, verified email, active state and PCN history. It clears department/signing permissions, revokes sessions and automatic signing-mail routing, and moves the account to Pending access. Active employee accounts then use read-only Records; inactive and maintenance accounts retain their existing restrictions. Removing the last active employee Administrator is blocked.

**Edit access** requires a confirmed directory work email before saving, including Administrator and non-signing assignments. A retained verified email counts; typing an address clears that confirmation until a result is selected. Pending accounts also require explicit role and department selection. The API rejects edits without verified mail. Role removal remains available without an email, and Create user/Link rules are unchanged.

Automatic updates use existing authorized GET APIs every five seconds while the page is visible. Portal records, Users, read-only Records and saved PCN details redraw only when their data changes, preserving filters, focus and scroll position. Refresh pauses during busy actions, open dialogs and Mail Routing edits; hidden pages pause and failed polls back off to at most thirty seconds. A clean saved PCN loads newer data automatically. With unsaved edits, **This record changed** offers **Reload latest** and requires discard confirmation; the existing saved-version baseline remains intact until reload. Automatic refresh sends no mail and performs no SQL writes. Introduced in signed runtime 15, this feature is retained in runtime 17; acceptance evidence is recorded below.

**View** in each Portal record's Actions column opens a read-only horizontal change timeline. Each point shows its recorded time, person and signing action, such as **GSC/TET — Checked** or **GSC/TET — Approved**; other events show their recorded workflow status, creation or history baseline. Cleared signatures are identified explicitly. Selecting a point shows recorded before/after form and signing changes, with internal storage metadata omitted. Earlier unavailable history is identified rather than reconstructed. Timeline scrolling stays inside the popup on mobile, and Portal automatic updates pause while it is open. This feature is deployed and live browser acceptance passed in signed runtime 17.

Migrations 001–007 are now applied to the configured `Scn_DB` on SQL Server 2014 (compatibility 120), including the document-control schema, PCN-local employee constraints and Developer role catalog entry. The 2026-10-15 local startup repair confirmed only migration 007 was missing, applied that role seed and migration metadata through the guarded migration runner, and restored local `/api/ready` to HTTP 200 `ready`. Users, PCNs, role grants and master-data counts were unchanged; no Developer account was assigned. See [the repair evidence](plans/developer-access.md#local-startup-repair--2026-10-15). Migration **006_pcn_local_employee.sql** was applied during the earlier 2026-10-12 repair; the subsequent signed HTTPS deployment reused that schema. Migration 003 retired former AD mappings without automatically granting employee access. The original employee-code cutover provisioned a separate verified Administrator / IT account while preserving the prior three accounts; current assignments are maintained in Users. The first `itadmin` account and empty initial mail mapping are historical setup details. Existing Firebase records have not been imported.

Workbook-derived options come from `NSN-000244 Supplier Product and Process Change Notification Form.xlsx`. SQL saves the web form's PCN data, including ordered change rows and the complete nested internal review. This does not import or execute workbooks or macros.

**Local development — Records dashboard (not deployed):** Portal and read-only Records now share summary cards, next responsibility and signing progress, combined filters and saved views, a read-only Overview/Timeline/Documents preview, document-readiness badges, sorting, selectable columns, client-side pagination and filtered CSV export. Pending time uses a recorded status transition when available and otherwise labels the saved-record age; overdue requires an explicit valid review deadline. The current schema has no review-deadline field or editor, so no deadline is inferred from the target start date. Saved preferences are scoped to the signed-in account in browser storage and contain no record payloads. The authenticated overview endpoint batches document/status metadata while preserving existing access scope. See [the implementation record](plans/records-dashboard.md). Runtime `pcn-test-17-1` remains the last deployed release; this work stays local until the user explicitly says **deploy**.

**Local development — Developer access (not deployed):** Developer is a separate exclusive role with the same application permissions as Administrator, the Developer department and no assigned signing step. Selecting Developer in Add role, Create user or Edit access reveals an inline shared-password field; the server verifies it before granting or retaining Developer in the saved assignment. Developer accounts use normal sign-in. Only the shared password's Argon2id hash is configured as `PCN_DEVELOPER_PASSWORD_HASH`; missing or invalid configuration blocks saves granting or retaining Developer. Removing or demoting Developer requires no shared password. Only a Developer can edit access, deactivate, demote or remove roles from an existing Developer account; Administrators see protected actions and receive HTTP 403 from direct edit/removal requests. New Developer grants still require the shared assignment password. Developer does not count toward the last-Administrator safeguard or automatic signing-mail recipients. Migration 007 was applied during the 2026-10-15 local startup repair and seeds the role without assigning accounts. See [Developer access](plans/developer-access.md). This feature and the Records dashboard remain local; runtime `pcn-test-17-1` is unchanged.

**Local development — Signing order (not deployed):** Each internal department and QA/TET Final Judgment now follow **Prepared → Checked → Approved**. The form/print columns, signing gates, progress/timeline displays, Users and Mail Routing selectors, and action-required notifications use that order. Supplier columns use the same display order while retaining the supplier workflow. Final judgment and final-status authority require QA/TET Approved or the existing Administrator/Developer override, and entering Approved/Rejected/Closed requires every eligible internal group to be complete. Existing signature fields, role assignments, recipient-list keys and audit history keep their meanings and are not remapped. Existing active routing adopts the new pending action once on its next eligible save; unchanged saves after adoption do not repeat the handoff. All 759 unit/API tests pass with 92.37% line coverage; six signing-order, six timeline and thirteen document browser groups and all 120 full smoke checks pass. This change performs no automatic SQL migration, bulk backfill, host deployment or live mail send. See [the mail-routing design](plans/mail-routing-design.md).

**Local follow-up — Returned PCN Save:** Normal Save/Update resubmits a returned Supplier Action record to Submitted, allowing its next Prepared/Checked/Approved action notice to be planned. Save Draft keeps Supplier Action and queues no action handoff. Existing completion checks still apply; no operational record was resubmitted as part of this fix. All 759 unit/API tests and the expanded eight-group signing-order browser suite pass; coverage is 92.37% lines, 91.44% branches and 94.39% functions. On 2026-10-15 the local configured sender was restored after isolated verification; local readiness and an empty queue were confirmed, with private configuration unchanged and no mail sent. The fix remains local and has not been deployed.

## Setup

Use Node.js 22 or later:

```powershell
npm install
Copy-Item .env.example .env
```

Set `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PORT`, `PORT` and `PUBLIC_ORIGIN` for the installation. Supply `SQL_PASSWORD` through the process environment or a protected credential. Keep `.env` private; it is excluded from source control. The SQL login is the API connection account, separate from application users.

To enable Developer assignment changes, configure `PCN_DEVELOPER_PASSWORD_HASH` privately using the format described in [Developer access](plans/developer-access.md#private-configuration). Keep the committed template blank. The shared password belongs to the access-setting dialog; it is not requested during employee-code, PCN-local or ordinary password-maintenance sign-in.

Before linking an existing Developer account to another employee identity, remove its Developer access. Direct linking is rejected with HTTP 409 and no writes; after linking, assigning Developer again requires the shared password.

The Developer hash has been configured in the ignored local environment file and verified through the production password/configuration helpers and a fresh process load. No credential value is published. Migration 007 is now applied and local SQL-backed startup is ready; no Developer account has been assigned and no host application or deployment change has been made.

Production requires HTTPS by default. An explicitly configured internal HTTP installation can keep `NODE_ENV=production` and set `ALLOW_INTERNAL_HTTP=true`, with an exact RFC1918 IPv4 `PUBLIC_ORIGIN` such as `http://172.30.77.137:8443`, loopback `HOST`, and `TRUST_PROXY=loopback`. The reverse proxy must replace the client-IP header and restrict access to the employee networks. HTTP uses a separate `pcn_session_http` cookie to avoid collisions with existing Secure HTTPS cookies; HttpOnly, SameSite Strict, exact-origin and CSRF checks remain enabled. HTTP traffic is unencrypted.

SQL connections use encryption. `SQL_TRUST_SERVER_CERTIFICATE=false` is the default; use a trusted server certificate for deployment. An approved self-signed installation can explicitly set it to `true`.

On Windows, the runtime can read a DPAPI-protected credential for the same Windows account and computer:

```powershell
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'SupplierPCN'
New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
Get-Credential -UserName 'scndb' -Message 'SQL Server connection account' |
  Export-Clixml -LiteralPath (Join-Path $credentialDirectory 'sql-credential.xml')
```

The default location is `%LOCALAPPDATA%\SupplierPCN\sql-credential.xml`; `PCN_SQL_CREDENTIAL_PATH` can select another absolute path. A service needs a credential protected for its Windows identity. Do not run the credential-reading helper directly: its output is intended only for Node.

## Migrations and administrator provisioning

`Scn_DB` must already exist. Check connectivity:

```powershell
npm run db:check
```

The migration account needs database access and permission to create the `pcn` schema/tables and seed them. [The DBA permissions script](sql/grant-migration-permissions.sql) maps the existing login if needed, precreates the schema and grants scoped migration/data access without changing login credentials. It includes revocation steps for schema administration after migration. The runtime account needs application data access without schema alteration rights. Startup never creates tables automatically.

Apply reviewed migrations from source with `npm run db:migrate` before selecting the corresponding release. Startup and the release consumer never execute DDL. [Migration 003](sql/migrations/003_employee_code_auth.sql) was applied at `2026-10-07T03:35:30.942Z`; 001/002 were unchanged. It adds provider state, retires former AD mappings and revokes their sessions/tokens. This rollout created the separately approved employee `2205529` Administrator / IT account without relinking the unrelated former AD administrator. Future explicit links preserve the intended existing PCN user ID, roles and ownership; never infer a source code from SamAccountName or import all employees as a substitute.

For a fresh installation that requires a temporary maintenance administrator, password bootstrap remains available privately. This creates a legacy password account for explicit `AUTH_MODE=password` maintenance, not the normal employee login:

```powershell
$bootstrapCredential = Get-Credential -UserName 'itadmin' -Message 'Initial application administrator'
$env:PCN_BOOTSTRAP_USERNAME = $bootstrapCredential.UserName
$env:PCN_BOOTSTRAP_PASSWORD = $bootstrapCredential.GetNetworkCredential().Password
try { npm run db:migrate }
finally {
  Remove-Item Env:PCN_BOOTSTRAP_USERNAME -ErrorAction SilentlyContinue
  Remove-Item Env:PCN_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
}
```

`db:migrate` applies checksummed migrations and seeds workbook-derived master data. Maintenance bootstrap creates the password administrator only if that username is absent. Passwords are stored as Argon2id hashes; first password login requires changing the password, and changes revoke sessions. Email is optional (`PCN_BOOTSTRAP_EMAIL`). Employee-code accounts, including Developer, have no additional sign-in password. The local Developer feature verifies its shared password only when saving a Developer assignment in access settings. First sign-in creates a roleless account with read-only Records access; PCN actions require administrator-assigned permissions.

`AUTH_MODE=employee-code` is the normal default; `AUTH_MODE=password` is an explicit maintenance choice for eligible unlinked legacy accounts. Employee codes remain text, including leading zeros. The source provides English/Thai names, job title and department hints but no email or active flag. Current source presence and an active PCN account allow read-only access for roleless employees. Protected requests still revalidate the current source, account and session; source outages fail closed with 503. First sign-in creates an account with no role or department, visible in Admin → Users for assignment. AD, Windows SSO, its proof headers/module/helper and its sign-in route are removed from the replacement runtime. Existing PCN signing/ownership rules and mail-directory lookup are preserved.

Mail routing starts empty. Leave `POWER_AUTOMATE_MAIL_URL`, `POWER_AUTOMATE_DIRECTORY_URL` and `INTEGRATION_ALLOWED_HOSTS` empty until configured. No default recipient is used.

## Run

For local development, restart the server automatically when its JavaScript files change:

```powershell
npm run dev
```

This uses the same SQL and private configuration as `npm start`. Refresh the browser after frontend changes. For a regular run:

```powershell
npm start
```

Open `http://localhost:3000` for the configured local port. Login is `/login`, Portal is `/admin`, Records is `/records`, and a saved record is `/PCN-YYYY-NNNN`. Users with at least one assigned PCN role open Portal after normal sign-in and are redirected from Records to Portal; assigned users retain valid direct-link return destinations. Source-verified active roleless employees open Records by default and can view all PCNs; their detail page links back to Records. The Create page has no Records button. Roleless employees cannot create, edit, sign, comment, upload, delete or trigger mail, and cannot use administration or audit APIs. Portal shows records within assigned users' existing access scope; Mail Routing, Users, removal and workflow status controls require an administrator. The browser also accepts `/form.html?id=PCN-YYYY-NNNN` and normalizes legacy `PNC`/three-digit aliases.

The login page uses Cairoli Classic and starts sign-in when the user enters all seven Employee ID digits. Pending sign-in disables the ID field and button to prevent duplicate requests. A failed attempt stays on the page; editing the ID or pressing Sign in allows another attempt. Password maintenance still uses explicit submission.

The server checks schema and master data before listening. Use `NODE_ENV=production` and a `PUBLIC_ORIGIN` matching the browser origin. HTTPS is required unless the scoped internal HTTP setting above is explicitly enabled. Authentication uses an HttpOnly, SameSite Strict cookie and CSRF headers for mutations. Production HTTPS cookies use Secure; the internal HTTP cookie uses its separate name. Serve through Node so its asset allowlist protects source, configuration and exports.

`npm run start:windows` is an additional Windows credential launcher. Use `npm start` with the runtime's configurable credential location or environment configuration.

### Administrator update emails (local development)

Administrator informational PCN update emails are limited to their assigned department's changes. Unassigned Administrators no longer receive every update. Pending update recipients are rechecked against their saved department and event scope before sending; next-action workflow emails retain their existing routing.

### Developer Tools (local development)

Active Developer accounts have a **Developer Tools** menu linking to `/developer`. Administrators and other roles cannot use its APIs. Select a PCN, then use **Workflow** to inspect actual Prepared → Checked → Approved signatures, the next action, assigned people and missing document requirements. **Document Transactions** lists recorded saves with time, person, revision, changed field and before/after values; search, UTC date filters and pagination apply to the selected PCN. Earlier unavailable history is identified explicitly. These tools are read-only and do not send mail or change documents. Run `npm run test:developer-tools` for isolated browser acceptance.

### Guided PCN creation (local development)

Clicking the Portal's **Create PCN** label opens the Create page. Hovering over it or activating its separate arrow opens the four shortcuts: **Blank PCN**, **Common change starter**, **Copy existing PCN** or **Resume draft**. Opening these entry choices does not create a record or queue mail. Users table role and department badges show Developer in yellow, Administrator in green and other assigned values in black; unassigned values keep a yellow pending indicator.

`/create` opens **Details → Changes → Documents → Review & Submit**, with shared readiness checks, inline errors, document upload cards and a compact bottom-right error checklist. Draft edits save to the current user's account and can be resumed on another computer. Opening the page does not create a record; submission is an explicit final action. Concurrent edits use rowversions and draft creation retries reuse the same identity.

Blank documents, common change starters and safe copies of existing PCNs are available. **Test document** fills sample values and permanently marks the resulting document **TESTING DOC**, including Records, the official sheet, printed copies and workflow mail. Copying a test document retains its marker. Test documents use normal validation, attachment scanning and workflow rules; submitting one can queue ordinary workflow notifications.

**Preview document** opens a read-only popup containing only the official PCN sheet, with Close/Escape returning to Create. It saves the current draft first and opens no new tab. Printing and signing remain available from `/form.html?id=PCN-YYYY-NNNN`. Required files count as ready only after a trusted clean scan. Receipt statuses distinguish queued notifications from workflow acceptance; acceptance does not confirm inbox delivery. No migration is required for this feature, and it has not been deployed. Run `npm run test:create` for isolated browser verification with synthetic records, file metadata and captured notification jobs.

For local LAN development, set `HOST=0.0.0.0` and `PUBLIC_ORIGIN=http://<local-LAN-IP>:3000` in the private local environment file, restart the development watcher and open that LAN URL. Keep an inbound TCP rule for the configured port. These local settings do not change the deployed host.

## Windows internal pilot

The employee-code pilot runs on `THCHA-WEBHOST01` at `http://172.30.77.137:8443`, using the separate IIS `PCNTest` site/application pool and `SupplierPCNTest` Node service on loopback port 3000. Signed runtime `pcn-test-17-1` is installed with the Portal timeline and automatic browser updates. Exact-release Node PID 9280, NetworkService / WinSW ownership, exclusive loopback listener and public HTTP SQL readiness passed. The three timeline assets served over HTTP match the deployed source after line-ending normalization. Live acceptance passed five groups and fifteen read-only API responses, including an existing PCN's five events with actual GSC/TET signing labels/people, selection and desktop/mobile fit. Only login/logout writes were sent; no business writes, mail, directory/external attempts or unexpected errors occurred. One notification-health read was blocked locally; profile reads were configured to be locally stubbed but none occurred. The SYSTEM task is enabled / Ready / result 0. A repeat consumer returned `already_current` for runtime 17 with Node PID 9280 unchanged, and independent final checks confirmed HTTP/SQL readiness. Runtime 15's eight live automatic-update groups and unchanged-PID no-op remain historical evidence in [the Windows deployment runbook](plans/windows-test-deployment.md).

This pilot uses the existing `svr120a / Scn_DB`: PCN saves are real persistent database writes. Deployment reuses the applied schema and accounts; it does not run migration, import or bootstrap. Recipient routing is maintained separately. Windows 10 Pro has a small IIS concurrency limit, so this host is for a limited pilot; wider use requires an appropriate Windows Server deployment.

The [GitHub deployment pipeline](plans/github-deployment.md) deployed signed [pcn-test-17-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-17-1) from main `6f3b7397139388b3d02a746fdd56cd2ae8349636`, at observed host time `2026-10-14T07:41:08.6651173Z`. [Actions 38526805589](https://github.com/akwaa2545-gif/PCN-/actions/runs/38526805589) passed 645 unit/API tests, the existing browser suite, six automatic-update groups, six timeline groups and the dependency audit gate. Archive SHA-256: `3322a8d92bbd480b915007e6cd00394d34bbd021c7ef8b65c93e58ef484a1cda`. GitHub holds the release-signing key, not SQL credentials. Private configuration and proxy hashes/ACLs, HTTP binding/firewall, the protected consumer, pinned key and retained recovery certificate were unchanged. Earlier runtime 14/15 HTTP acceptance remains historical evidence in the runbooks.

Historical `pcn-test-13-1` acceptance confirmed Node PID 19360 / WinSW parent PID 6300, NetworkService ownership and exclusive loopback port 3000. Trusted HTTPS readiness, fourteen matching public assets, four private-path denials and desktop/mobile acceptance passed. Its nine browser groups included the yellow Pending access indicator and disabled Save without selected mail. Read-only schema checks found migrations 001–006 applied, and deployment performed no DDL, account import or test email. Its repeated consumer poll returned `already_current`; full historical evidence is retained in the deployment runbooks.

**PCNTest only** has Anonymous Authentication enabled / Windows Authentication disabled; the retired identity module/key were protected/archived and removed from the live site. The HTTP conversion changed only `PUBLIC_ORIGIN`, `ALLOW_INTERNAL_HTTP`, the existing IIS / HTTP.sys port 8443 binding and PCNTest's Require SSL access setting. SQL/mail secrets, existing pool permissions, loopback isolation, employee-network firewall scope and proxy web.config were retained. The ordinary proxy overwrites `X-PCN-Client-IP` from `REMOTE_ADDR`; employee-code access has no AD header proof. The former certificate remains in the host machine store. Company certificate request `1580097` was pending at the last recorded check on 2026-10-12 and is relevant only to an optional future return to HTTPS.

## Import existing PCN data

`data/pcn-db.json` contains three synthetic prototype records, not a Firebase export. It is not automatically imported. Only import an explicit, reviewed source:

```powershell
npm run db:import -- C:\private\pcn-export.json
```

The importer expects `pcnRequests` keyed by PCN code, optional `auditLogs`, and optional annual counters. A Firestore export must first be converted and reconciled into that shape; this is not a direct Firestore export reader. Import preserves IDs, nested fields, ordered child payloads and source hashes, skips identical imported records, and rejects changed/conflicting records instead of overwriting them. It does not enqueue mail. Source routing settings are excluded to preserve empty mail mapping.

Back up and freeze the source for final cutover. Reconcile counts, hydrated fields, ownership and counters before switching writers. Imported records without verified `ownerUserId` are unavailable to suppliers. Historical uploaded flags do not create file bytes. Restrict access to private source archives in SQL.

## Mail and attachments

Administrators configure recipients in **Mail Routing**; recipient mapping and directory-assisted recipient selection remain editable. The signed Power Automate mail URL is fixed in private server configuration and cannot be edited through the UI or routing API. On the Windows host, set `POWER_AUTOMATE_MAIL_URL` and its exact hostname in `INTEGRATION_ALLOWED_HOSTS` inside the protected file selected by `PCN_ENV_FILE`. The actual URL must never enter source control, GitHub Actions, release archives or browser responses. Integration endpoints require HTTPS and exact allowed hosts. Empty mapping still skips notifications: no fallback recipient is restored.

Workflow mail preserves the original Power Automate JSON contract with exactly `to`, `subject`, `message` and `senderName`. The message is the escaped **Supplier PCN Workflow** HTML card with PCN, supplier, material, risk, Current Status, Next To Check and an Open PCN button. Recipients, review groups and the portal link are resolved by the server. Workflow requests enqueue deduplicated SQL jobs; the worker polls every five seconds when mail is configured.

The compact admin **Mail service** row has a status badge and **Check status** button while retaining recipient routing edits. **Ready** means valid configuration with no known worker error/uncertain outcome or uncertain queued jobs; it does not confirm email delivery. Other results are **Not configured**, **Needs attention** or **Unavailable**. The unchanged admin-only `GET /api/admin/notifications/health` reads configuration and SQL/worker details without invoking Power Automate, changing jobs or sending email. Queue/timestamp details remain in the API response, not the compact UI. The compatibility test-mail POST is not invoked by this button.

The earlier mail/health change passed local verification and backend, JavaScript, code and security reviews: its coverage run passed 148 tests with 95.00% line, 87.54% branch and 94.67% function coverage, plus 14 isolated browser checks without SQL or flow calls. These are historical results, separate from the latest full-suite results below and the earlier deployed release's 134 tests/seven browser checks. Release CI and live acceptance are separate from local verification.

Private mail/directory configuration is stored outside releases on the host. The directory update retained the existing mail/SQL values, file permissions and protected backup under the deployment mutex, after a zero pending/sending-job check; that configuration update made no SQL mutations, restarted no service and invoked no flow. The subsequent release deployment restarted the service with the new configuration. Mail configuration passes local validation, and a host-side directory lookup returned one matching profile with an inline photo. No mail test or delivery verification was performed. Normal queued workflow jobs are processed by the worker when mail is configured.

Directory lookup uses a distinct private `POWER_AUTOMATE_DIRECTORY_URL`, with its exact hostname in `INTEGRATION_ALLOWED_HOSTS`; it is different from the mail endpoint. The original directory configuration was recovered once through a read-only lookup of legacy Firestore settings. The SQL app now calls Power Automate directly from the backend, with no Firebase runtime dependency. Local integration settings remain in the ignored private `.env`; they are separate from host configuration. Private configuration remains external to release files.

The admin directory API sends the same search text as both `query` and `searchTerm` and accepts an array or `users`, `value` or `results` response. It returns bounded profile fields, including job title/department, and permits inline PNG/JPEG/GIF/WebP photos whose complete data URI is at most 100 KiB; remote image URLs are dropped. Live backend lookups locally and from the host returned a matching profile with those fields. Isolated browser checks confirmed dropdown rendering, and deployed HTML contains the compact mail row. Identifying values and signed endpoint details stay private. Actual authenticated use of the deployed health/directory UI remains unverified.

The deployed profile enhancement adds a larger account photo and a separate Sign out footer. Authenticated `GET /api/profile` uses the existing private Power Automate directory configuration to enrich only the current user's displayed photo, email and job title. Verified stored directory links match by ID/email; otherwise the server searches the employee source's English name and requires one exact normalized name match. Missing, ambiguous or failed lookups keep initials. Results are cached for five minutes; account fields, permissions and mail routing are not updated. Run `npm run test:profile` for isolated desktop/mobile browser checks.

The deployed document sidebar includes **History**, **Attachments**, **Checks**, next-action assignments and **Print / PDF**. Draft recovery and Save draft protect unfinished work. Signatures bind to a content revision; administrators can start a reasoned revision while retaining earlier evidence. See [document control](plans/document-control.md) for behavior, APIs and acceptance boundaries. Migration 005 was applied to `svr120a / Scn_DB` before this rollout. The host attachment scanner remains disabled: pending files stay quarantined and cannot satisfy required-document checks.

Attachments store PDF, PNG, JPEG or UTF-8 text in SQL, capped at 10 MiB per file and 20 files / 50 MiB per PCN. Upload/removal require the current PCN version, revalidate permissions/stage, and record history/audit atomically. Removal retains historical bytes. Files remain quarantined until a trusted scan passes; requirement checkboxes alone do not satisfy completion checks.

## Verification and remaining work

```powershell
npm test
npm run test:coverage
npx playwright install chromium
npm run test:e2e
npm run test:documents
npm run test:auto-refresh
npm run test:timeline
npm run test:records-dashboard
npm run test:developer-role
npm run test:create
```

The local Records dashboard source passed 682/682 unit/API tests with 91.92% line / 91.09% branch / 93.80% function coverage and 12 isolated dashboard browser groups using 17 fixture records, with no browser errors, external calls or forbidden writes. The standalone full application browser smoke suite and existing Records, timeline and automatic-update regressions also passed. Its implementation and browser evidence are recorded in [the dashboard plan](plans/records-dashboard.md). This is local verification, not a new deployment.

The corrected local Developer assignment-password implementation passed 736/736 tests with 92.08% line / 91.24% branch / 93.85% function coverage using `npm run test:coverage -- --test-concurrency=4`. All eight isolated Developer browser groups passed with no browser errors, external calls or forbidden writes; desktop/mobile access settings and normal Developer sign-in were verified. Ordinary-login regression passed all eight groups, and the full application smoke suite passed all 120 checks with cleanup complete. Code and security reviews approved the change. See [Developer verification](plans/developer-access.md#verification) for completed local evidence. Migration 007 is applied and local SQL startup is ready; no deployment has occurred.

The timeline source passed 645 unit/API tests with 91.68% line / 90.87% branch / 93.83% function coverage. Its six isolated browser journeys covered 13 genuine events, signing department/person labels, before/after business fields, keyboard opening and closing, contained desktop/mobile scrolling, stale reads, empty/error/retry states and paused Portal refresh. These checks used isolated adapters and made no live business changes or external integration calls. Release CI and host acceptance are recorded separately in the deployment runbooks.

The earlier automatic-update source passed 635 unit/API tests; its modal guard also passed 43 targeted tests. All six isolated automatic-update browser groups passed: Portal, Users, Records, clean saved-detail and dirty-edit notice updates appeared within five seconds. Pause/resume was tested with synthetic visibility events because native headless visibility was unreliable; resume completed in 29 ms. Runtime 14 release CI separately passed 605 tests and the isolated browser suite; runtime 15 deployment and live acceptance are separately recorded above. Historical employee-code acceptance passed 26 checks each through local and HTTPS APIs, plus local SQL-backed browser login, Users/lookup and logout. The [historical acceptance record](plans/employee-code-authentication.md#acceptance--2026-10-07) is separate from current deployment acceptance; these checks do not establish email delivery.

The first release `pcn-test-5-1` passed 134 tests and seven isolated browser checks; its earlier 93.84% line/86.41% branch coverage is historical. The current release and its acceptance record are in the deployment runbooks.

Browser smoke checks passed for forced password change, re-login, empty routing, a blank supplier form, creation and reload using isolated test adapters. They do not establish actual authenticated browser use of the HTTPS pilot. `scripts/live-sql-smoke.js` separately verified the real database, authentication, Unicode workbook persistence, stale writes, attachment quarantine/audit and soft deletion inside a rolled-back transaction. It accepts the bootstrap password only through `PCN_SMOKE_BOOTSTRAP_PASSWORD` and is intended for initial setup, not routine deployment.

See [API inventory](plans/sql-server-api-checklist.md), [table mapping](plans/sql-server-table-mapping.md), and [migration plan](plans/sql-server-migration.md). The migration plan includes future acceptance criteria, not a declaration that every proposed feature exists.

Add role selects source employees or existing accounts; Create user creates PCN-local employees with explicit PCN grants. Remaining operational work includes live upload/scanning/save/signing acceptance, scanner provisioning, file retention, the user's Edge GUI observation, company membership/reviewer assignments, server-side list pagination, historical-master rendering, mail status/retry operations and general command idempotency. The local Records dashboard adds client-side pagination; it has not changed the live release. Source workbooks, prototype data, agent state and obsolete Firebase/JSON files remain local and are excluded from this SQL repository.
