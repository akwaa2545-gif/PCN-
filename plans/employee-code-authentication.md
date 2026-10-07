# Employee code authentication and SQL employee lookup

Updated: 2026-10-07. This is the replacement for the retired [AD / Windows authentication plan](employee-windows-authentication.md). The user chose employee-code-only login using the existing SQL employee database. Source implementation is in progress; the live server cutover, migration 003, verified administrator mapping and replacement release acceptance are pending. The deployed `pcn-test-9-1` remains the former Windows-authentication runtime until the reviewed cutover completes.

## Identity source and access

The employee source is on the existing SQL server `svr120a`, at `[KEY_Code_DB].[dbo].[tblEmployee]`. The supplied server shorthand `sv120a` is not a configuration change. The inspected table contained 1,935 rows, with a unique, non-null `EmpCode` column of type `nvarchar(10)`. No employee bulk import or source synchronization is planned. Every source operation is read-only and uses parameterized queries.

| Source field | Application use |
|---|---|
| `EmpCode` | Employee identifier and login input; preserve text and leading zeros |
| `PersonFNameEng`, `PersonLNameEng` | Display name when available |
| `PersonFNameThai`, `PersonLNameThai` | Display-name fallback |
| `PostNameEng` | Job-title hint in lookup results |
| `OrgID` | Source department hint; no automatic PCN permission grant |

The source has no email address or enabled/disabled flag. An employee must have a current source record **and** an explicitly provisioned, active PCN SQL account with provider `employee-code`. Administrators select a lookup result, assign PCN roles and choose the PCN department manually. Source department/job fields do not assign roles. Merely appearing among the 1,935 source employees grants no PCN access. Email recipient lookup remains the separate Power Automate integration.

Employee-code-only login deliberately allows anyone who knows an enabled employee's code to sign in as that employee. This is the user's chosen access model; it does not prove identity through a password, AD or Windows SSO.

Existing roles remain `admin`, `reviewer`, `supplier`, `gsc`, `productionengineering`, `qa` and `tapbu`. PCN department choices remain `gscTet`, `prodEngTet`, `qaTet`, `gscTapbu`, `qaTapbu`, `it` and `other`. Signing permissions, ownership rules and recipient routing remain independent of employee lookup.

## Runtime and API contract

`AUTH_MODE=employee-code` is the normal default. `AUTH_MODE=password` is an explicit maintenance option for unlinked legacy password accounts. Windows mode, Windows proof headers, the AD helper, the IIS identity module and Windows login routes are removed from the replacement runtime.

The normal login page accepts one employee code without a password. Code validation accepts 1–10 letters, digits, dots, underscores or hyphens; codes stay strings. The backend verifies current source presence and the active PCN mapping before issuing its normal session. Protected requests revalidate the source and PCN account/session state. Source unavailability fails closed with 503; it does not fall back to AD or password mode.

| Endpoint | Replacement contract |
|---|---|
| `GET /api/auth/config` | Public auth mode and whether employee provisioning is configured; no credentials or source infrastructure |
| `POST /api/auth/login` | In employee-code mode, `{employeeCode, remember?}`; no password or Windows identity input |
| `GET /api/admin/employees?query=...` | Administrator-only bounded employee-code/name search against the SQL source |
| `POST /api/admin/users` | Administrator selects `{employeeCode, roles, department}`; server re-queries the source before creating the account |
| `POST /api/admin/users/:uuid/employee` | Explicit link with `{employeeCode}`; selected source record is verified server-side |
| `POST /api/auth/logout` | Revoke the SQL session and clear the cookie, retaining origin/CSRF protection |

The `/employee` link route replaces the former AD `/directory` link route. Cookies remain HttpOnly / SameSite with Secure enabled in production. Mutations retain exact-origin and CSRF checks, role authorization and login throttling. Logout skips the source lookup so it remains available during a source outage.

## Schema and existing accounts

Apply [003_employee_code_auth.sql](../sql/migrations/003_employee_code_auth.sql) from reviewed source before selecting the replacement release. Startup validates schema but performs no DDL; runtime ZIPs exclude migrations. The source database/table is never altered by this migration.

Migration 003 adds an explicit identity provider. Existing password users remain `password`; former AD-mapped users become `retired-windows`, receive new security stamps and have outstanding sessions/account tokens revoked. Former AD SamAccountName mappings do not become enabled employee-code accounts automatically.

A verified, explicit source-code link preserves the existing PCN user ID, roles and PCN ownership, clears obsolete AD fields/password state, establishes provider `employee-code` and revokes prior sessions. Conflicting mappings are rejected instead of merged. The user confirmed code `2205529`, verified as WATCHARAPHONG BANYEN in the source. Provision a separate Administrator / IT account for this employee; do not relink the unrelated old AD administrator. Live provisioning remains pending.

Migration 002 was previously applied on 2026-10-07 with the original two users preserved and one explicitly selected AD administrator added. Before 002, a DPAPI-encrypted logical export covered 22 PCN tables / 108 rows and verified decryption. The SQL login lacked native `BACKUP DATABASE` permission; that export is not a native database backup and a full restore was not tested. Preserve these recovery limits and arrange an appropriate protected before-state for migration 003.

## Reviewed IIS and service cutover

1. Pause the `SupplierPCNTestDeployment` polling task before publishing/selecting the replacement runtime; preserve its protected trust anchors and current release/configuration records.
2. Confirm read-only source access and the administrator's intended source code. Preserve PCN data and the previous service/IIS configuration; apply migration 003 and verify schema readiness.
3. Create a separate Administrator / IT account for verified employee code `2205529`. Preserve existing user IDs, roles and ownership; do not import all source employees.
4. On **PCNTest only**, enable Anonymous Authentication and disable Windows Authentication. Archive/remove the old IIS Windows identity module and its separate proxy-key setup. Keep the HTTPS binding, certificate, other sites and backend SQL credentials protected.
5. Keep Node exclusively on loopback. Retain the ordinary IIS rewrite rule overwriting `X-PCN-Client-IP` with server-observed `REMOTE_ADDR`; no AD identity headers establish application access. Set normal `AUTH_MODE=employee-code` and remove obsolete AD/Windows auth settings from the protected backend environment.
6. Validate the signed replacement release and protected deployment consumer before switching. Verify SQL/source readiness, the exact Node/WinSW owner and loopback listener, then real employee-code login/session/authorization/logout through HTTPS.
7. Record the actual release and test results, then resume the polling task only after the reviewed cutover succeeds. These live steps are pending; no new release or GUI success is claimed here.

The existing NetworkService service identity and service-SID ACLs need not be weakened for this change. SQL/source credentials remain server-side and outside Git/releases. The VPN extension incident belongs to the former Windows-challenge path; normal employee-code login does not issue that native authentication challenge.

## Acceptance and recovery

Verify leading-zero codes, source-missing/unprovisioned/disabled-account denial, source-outage 503, prior AD session revocation, explicit-link ownership preservation, selected employee creation and real administrator login. Verify password maintenance mode separately, and ensure employee-provider sessions do not become valid through a mode switch. Check CSRF/origin, supplier/reviewer restrictions and mail-routing separation.

If cutover fails, keep the polling task paused and restore a reviewed, schema-compatible application/configuration state. Migration 003 retires old Windows mappings and revokes sessions, so restarting the old release alone does not restore its former login access. Restore or re-provision only the approved account mapping through a reviewed recovery procedure; do not automatically undo schema/data or reactivate every former AD user.

Related: [Windows deployment runbook](windows-test-deployment.md), [GitHub release pipeline](github-deployment.md), [API inventory](sql-server-api-checklist.md), [table mapping](sql-server-table-mapping.md).
