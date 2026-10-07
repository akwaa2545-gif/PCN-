# Supplier PCN workflow — SQL Server

Updated: 2026-10-07.

The Node API stores PCN form data, internal review, comments, approvals, audit history, routing settings and application accounts in SQL Server. The browser calls the API; the active application does not use Firebase Authentication or Firestore. The existing target is `svr120a / Scn_DB`.

Employee-code-only login is deployed, backed by read-only `[KEY_Code_DB].[dbo].[tblEmployee]` on the same `svr120a` server. Administrators select an existing employee, then grant PCN roles and a PCN department; the 1,935-row employee source is not imported or modified. Signed `pcn-test-10-1`, migration 003 and the approved separate Administrator / IT account are accepted. See [the employee-code plan](plans/employee-code-authentication.md) for the source model and complete evidence.

Migrations 001/002/003 are applied on SQL Server 2014 (compatibility 120), with 21 application tables plus `SchemaMigrations` and master-data version 1. Migration 003 retired former AD mappings without automatically granting employee access. The separate verified employee `2205529` / WATCHARAPHONG BANYEN has Administrator / IT access; the prior three accounts were preserved. The first `itadmin` account and empty initial mail mapping are historical setup details. Existing Firebase records have not been imported.

Workbook-derived options come from `NSN-000244 Supplier Product and Process Change Notification Form.xlsx`. SQL saves the web form's PCN data, including ordered change rows and the complete nested internal review. This does not import or execute workbooks or macros.

## Setup

Use Node.js 22 or later:

```powershell
npm install
Copy-Item .env.example .env
```

Set `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PORT`, `PORT` and `PUBLIC_ORIGIN` for the installation. Supply `SQL_PASSWORD` through the process environment or a protected credential. Keep `.env` private; it is excluded from source control. The SQL login is the API connection account, separate from application users.

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

`db:migrate` applies checksummed migrations and seeds workbook-derived master data. Maintenance bootstrap creates the password administrator only if that username is absent. Passwords are stored as Argon2id hashes; first password login requires changing the password, and changes revoke sessions. Email is optional (`PCN_BOOTSTRAP_EMAIL`). Normal employee-code accounts have no PCN password and must be explicitly provisioned from the source lookup.

`AUTH_MODE=employee-code` is the normal default; `AUTH_MODE=password` is an explicit maintenance choice for eligible unlinked legacy accounts. Employee codes remain text, including leading zeros. The source provides English/Thai names, job title and department hints but no email or active flag. Current source presence, active PCN account/provider and assigned PCN roles determine access; source outages fail closed with 503. Create User lets administrators select an employee lookup result and assign the roles/department manually. AD, Windows SSO, its proof headers/module/helper and its sign-in route are removed from the replacement runtime. Existing PCN signing/ownership rules and mail-directory lookup are preserved.

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

Open `http://localhost:3000` for the configured local port. Login is `/login`, administration is `/admin`, and a saved record is `/PCN-YYYY-NNNN`. The browser also accepts `/form.html?id=PCN-YYYY-NNNN` and normalizes legacy `PNC`/three-digit aliases.

The server checks schema and master data before listening. Production requires `NODE_ENV=production` and an HTTPS `PUBLIC_ORIGIN` matching the browser origin; use an HTTPS reverse proxy. Authentication uses an HttpOnly, SameSite cookie and CSRF headers for mutations. Secure cookies are enabled in production. Serve through Node so its asset allowlist protects source, configuration and exports.

`npm run start:windows` is an additional Windows credential launcher. Use `npm start` with the runtime's configurable credential location or environment configuration.

## Windows HTTPS pilot

The employee-code HTTPS pilot is on `THCHA-WEBHOST01` at `https://172.30.77.137:8443`, using the separate IIS `PCNTest` site/application pool and `SupplierPCNTest` Node service on loopback port 3000. NetworkService ownership, WinSW parent, listener isolation and SQL readiness passed. Real HTTPS acceptance passed 26 checks with CA/IP verification and no Windows authentication challenge. Local real API and SQL-backed headless browser checks also passed; the user's own Edge GUI remains unobserved. See [the Windows deployment runbook](plans/windows-test-deployment.md).

This pilot uses the existing `svr120a / Scn_DB`: PCN saves are real persistent database writes. Deployment reuses the applied schema and accounts; it does not run migration, import or bootstrap. Recipient routing is maintained separately. Windows 10 Pro has a small IIS concurrency limit, so this host is for a limited pilot; wider use requires an appropriate Windows Server deployment.

The [GitHub deployment pipeline](plans/github-deployment.md) deployed signed [pcn-test-10-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-10-1) from main `c827d9c1c23c27631604936807dbbc352101c11e`, after [Actions 37567205169](https://github.com/akwaa2545-gif/PCN-/actions/runs/37567205169) passed. The protected SYSTEM task was resumed after the reviewed cutover and is enabled / Ready / result 0; a repeated poll was a no-op. It polls outbound every ten minutes and at startup, with no public deployment listener or self-hosted CI runner. GitHub holds the release-signing key, not SQL credentials.

**PCNTest only** now has Anonymous Authentication enabled / Windows Authentication disabled; the retired identity module/key were protected/archived and removed from the live site. HTTPS, SQL/mail secrets, existing pool permissions and loopback isolation were retained. The ordinary proxy overwrites `X-PCN-Client-IP` from `REMOTE_ADDR`; employee-code access has no AD header proof. Default Web Site HTTP :80 remains available.

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

Directory lookup uses a distinct private `POWER_AUTOMATE_DIRECTORY_URL`, with its exact hostname in `INTEGRATION_ALLOWED_HOSTS`; it is different from the mail endpoint. The original directory configuration was recovered once through a read-only lookup of legacy Firestore settings. The SQL app now calls Power Automate directly from the backend, with no Firebase runtime dependency. The ignored local `.env` enables directory lookup only and does not enable local mail. Private configuration remains external to release files.

The admin directory API sends the same search text as both `query` and `searchTerm` and accepts an array or `users`, `value` or `results` response. It returns bounded profile fields, including job title/department, and permits inline PNG/JPEG/GIF/WebP photos whose complete data URI is at most 100 KiB; remote image URLs are dropped. Live backend lookups locally and from the host returned a matching profile with those fields. Isolated browser checks confirmed dropdown rendering, and deployed HTML contains the compact mail row. Identifying values and signed endpoint details stay private. Actual authenticated use of the deployed health/directory UI remains unverified.

Attachment APIs store PDF, PNG, JPEG or UTF-8 text in SQL, capped at 10 MiB per file and 20 files / 50 MiB per PCN. Upload/delete require the PCN version and atomically recheck permissions/stage, advance the version and record an audit. Uploads are `pendingScan`; downloads return 423 until a trusted scanner marks them clean. Scanner integration and the attachment upload interface are pending. Form document checkboxes are requirement/history flags, not proof of scanned content.

## Verification and remaining work

```powershell
npm test
npm run test:coverage
npx playwright install chromium
npm run test:e2e
```

Employee-code verification passed 240 unit/API tests with 95.85% line / 89.32% branch / 96.32% function coverage and 59 isolated browser checks. Real local and HTTPS API acceptance each passed 26 checks, and a real headless browser against the local SQL-backed runtime passed login, Users/lookup, role/department controls and logout. The [complete acceptance record](plans/employee-code-authentication.md#acceptance--2026-10-07) distinguishes these results from the user's unobserved Edge GUI and operational PCN saves; no email delivery is claimed.

The first release `pcn-test-5-1` passed 134 tests and seven isolated browser checks; its earlier 93.84% line/86.41% branch coverage is historical. The current release and its acceptance record are in the deployment runbooks.

Browser smoke checks passed for forced password change, re-login, empty routing, a blank supplier form, creation and reload using isolated test adapters. They do not establish actual authenticated browser use of the HTTPS pilot. `scripts/live-sql-smoke.js` separately verified the real database, authentication, Unicode workbook persistence, stale writes, attachment quarantine/audit and soft deletion inside a rolled-back transaction. It accepts the bootstrap password only through `PCN_SMOKE_BOOTSTRAP_PASSWORD` and is intended for initial setup, not routine deployment.

See [API inventory](plans/sql-server-api-checklist.md), [table mapping](plans/sql-server-table-mapping.md), and [migration plan](plans/sql-server-migration.md). The migration plan includes future acceptance criteria, not a declaration that every proposed feature exists.

Create User selects SQL-source employees with explicit PCN role/department grants. Remaining work includes the user's Edge GUI observation, operational save/signing/link acceptance, role/disable management, company membership/reviewer assignments, list pagination, historical-master rendering/version API, attachment scanning/UI, mail status/retry operations and general command idempotency. Source workbooks, prototype data, agent state and obsolete Firebase/JSON files remain local and are excluded from this SQL repository.
