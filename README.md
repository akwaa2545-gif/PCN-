# Supplier PCN workflow — SQL Server

Updated: 2026-10-06.

The Node API stores PCN form data, internal review, comments, approvals, audit history, routing settings and application accounts in SQL Server. The browser calls the API; the active application does not use Firebase Authentication or Firestore. The existing target is `svr120a / Scn_DB`.

Current setup: migration `001_core.sql` is applied on SQL Server 2014 (compatibility 120), with 21 application tables plus `SchemaMigrations`, master-data version 1, and the first `itadmin` account. Its email is null and first login requires a password change. All seven email groups are empty. Live SQL round-trip checks passed; their test writes were rolled back. Existing Firebase records have not been imported.

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

## Create tables and the first administrator

`Scn_DB` must already exist. Check connectivity:

```powershell
npm run db:check
```

The migration account needs database access and permission to create the `pcn` schema/tables and seed them. [The DBA permissions script](sql/grant-migration-permissions.sql) maps the existing login if needed, precreates the schema and grants scoped migration/data access without changing login credentials. It includes revocation steps for schema administration after migration. The runtime account needs application data access without schema alteration rights. Startup never creates tables automatically.

Supply the requested first username `itadmin` and temporary password privately. This prompts for the password instead of including it in documentation or scripts:

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

`db:migrate` applies checksummed migrations and seeds workbook-derived master data. Bootstrap creates the administrator only if that username is absent. Passwords are stored as Argon2id hashes. First login requires changing the password; passwords must be nonempty and no more than 128 characters. There is no minimum-length policy. Password change revokes sessions and requires re-login. Email is optional (`PCN_BOOTSTRAP_EMAIL`).

Mail routing starts empty. Leave `POWER_AUTOMATE_MAIL_URL`, `POWER_AUTOMATE_DIRECTORY_URL` and `INTEGRATION_ALLOWED_HOSTS` empty until configured. No default recipient is used.

## Run

```powershell
npm start
```

Open `http://localhost:3000` for the configured local port. Login is `/login`, administration is `/admin`, and a saved record is `/PCN-YYYY-NNNN`. The browser also accepts `/form.html?id=PCN-YYYY-NNNN` and normalizes legacy `PNC`/three-digit aliases.

The server checks schema and master data before listening. Production requires `NODE_ENV=production` and an HTTPS `PUBLIC_ORIGIN` matching the browser origin; use an HTTPS reverse proxy. Authentication uses an HttpOnly, SameSite cookie and CSRF headers for mutations. Secure cookies are enabled in production. Serve through Node so its asset allowlist protects source, configuration and exports.

`npm run start:windows` is an additional Windows credential launcher. Use `npm start` with the runtime's configurable credential location or environment configuration.

## Windows HTTPS pilot

The HTTPS pilot is deployed on `THCHA-WEBHOST01` at `https://172.30.77.137:8443`, using the separate IIS `PCNTest` site/application pool and `SupplierPCNTest` Node service on loopback port 3000. TLS checks with the pinned public certificate and IP verification passed; health/readiness and the login page return 200. Service restart passed, and port 3000 is unreachable from the workstation. Unauthenticated PCN requests are denied. Actual authenticated pilot login and browser certificate validation are still pending. See [the Windows test deployment runbook](plans/windows-test-deployment.md) for exact release/configuration paths, certificate trust and acceptance evidence.

This pilot uses the existing `svr120a / Scn_DB`: PCN saves are real persistent database writes. Deployment reuses the applied schema and accounts; it does not run migration, import or bootstrap. Mail mappings remain empty. Windows 10 Pro has a small IIS concurrency limit, so this host is for a limited pilot; wider use requires an appropriate Windows Server deployment.

The requested [GitHub deployment pipeline](plans/github-deployment.md) has successfully built and deployed signed release `pcn-test-5-1`. [Actions run 37411798943](https://github.com/akwaa2545-gif/PCN-/actions/runs/37411798943) passed all 134 tests and seven isolated browser checks. The protected SYSTEM task deployed the release to `C:\SupplierPCN\releases\pcn-test-5-1`; external HTTPS readiness and access-boundary probes passed afterward. The active release runs as LocalService on loopback, and a repeated poll returned `already_current` without restarting it. The task polls outbound every ten minutes and at startup, with no public inbound deployment endpoint or self-hosted CI runner. GitHub holds the release-signing key, not SQL credentials.

## Import existing PCN data

`data/pcn-db.json` contains three synthetic prototype records, not a Firebase export. It is not automatically imported. Only import an explicit, reviewed source:

```powershell
npm run db:import -- C:\private\pcn-export.json
```

The importer expects `pcnRequests` keyed by PCN code, optional `auditLogs`, and optional annual counters. A Firestore export must first be converted and reconciled into that shape; this is not a direct Firestore export reader. Import preserves IDs, nested fields, ordered child payloads and source hashes, skips identical imported records, and rejects changed/conflicting records instead of overwriting them. It does not enqueue mail. Source routing settings are excluded to preserve empty mail mapping.

Back up and freeze the source for final cutover. Reconcile counts, hydrated fields, ownership and counters before switching writers. Imported records without verified `ownerUserId` are unavailable to suppliers. Historical uploaded flags do not create file bytes. Restrict access to private source archives in SQL.

## Mail and attachments

Administrators configure recipients in **Mail Routing**. Signed Power Automate URLs stay in backend environment variables. Integration endpoints require HTTPS and exact hosts in comma-separated `INTEGRATION_ALLOWED_HOSTS`. Empty routing skips notifications. Workflow requests enqueue deduplicated SQL jobs; the worker polls every five seconds when mail is configured. HTTP acceptance does not prove delivery, and ambiguous outcomes require operator review.

Attachment APIs store PDF, PNG, JPEG or UTF-8 text in SQL, capped at 10 MiB per file and 20 files / 50 MiB per PCN. Upload/delete require the PCN version and atomically recheck permissions/stage, advance the version and record an audit. Uploads are `pendingScan`; downloads return 423 until a trusted scanner marks them clean. Scanner integration and the attachment upload interface are pending. Form document checkboxes are requirement/history flags, not proof of scanned content.

## Verification and remaining work

```powershell
npm test
npm run test:coverage
npx playwright install chromium
npm run test:e2e
```

The release's Windows CI run passed all 134 tests and seven isolated browser checks. An earlier local coverage run measured 93.84% lines and 86.41% branches; this is separate from the final CI test count. The corrected Windows DPAPI fixtures are included in the successful CI run. SQL-backed HTTPS readiness and unauthenticated access boundaries also passed on the deployed host.

Browser smoke checks passed for forced password change, re-login, empty routing, a blank supplier form, creation and reload using isolated test adapters. They do not establish actual authenticated browser use of the HTTPS pilot. `scripts/live-sql-smoke.js` separately verified the real database, authentication, Unicode workbook persistence, stale writes, attachment quarantine/audit and soft deletion inside a rolled-back transaction. It accepts the bootstrap password only through `PCN_SMOKE_BOOTSTRAP_PASSWORD` and is intended for initial setup, not routine deployment.

See [API inventory](plans/sql-server-api-checklist.md), [table mapping](plans/sql-server-table-mapping.md), and [migration plan](plans/sql-server-migration.md). The migration plan includes future acceptance criteria, not a declaration that every proposed feature exists.

Pending features include password recovery/invitations, user-management UI and role/disable endpoints, company membership/reviewer assignments, list pagination, historical-master rendering/version API, attachment scanning/UI, mail status/retry operations and general command idempotency. Source workbooks, prototype data, agent state and obsolete Firebase/JSON files remain local and are excluded from this SQL repository.
