# Employee code authentication and SQL employee lookup

Updated: 2026-10-07. Employee-code-only login is deployed as signed `pcn-test-10-1` from main `c827d9c1c23c27631604936807dbbc352101c11e`, replacing the retired [AD / Windows authentication pilot](employee-windows-authentication.md). Migration 003, the separate verified Administrator / IT account and PCN-only IIS cutover are complete. Real local and HTTPS API checks passed; the user's own Edge GUI has not been observed.

Current workspace change: a source employee can sign in before a PCN role is assigned. First sign-in creates a roleless account in `pcn.Users`; the employee sees an access-pending page and a no-role notice inside the profile panel, with Sign Out available and no PCN record access. Administrators assign roles and departments in Users. The signed release evidence below describes the earlier, explicitly provisioned baseline.

## Identity source and access

The employee source is on the existing SQL server `svr120a`, at `[KEY_Code_DB].[dbo].[tblEmployee]`. The supplied server shorthand `sv120a` is not a configuration change. The inspected table contained 1,935 rows, with a unique, non-null `EmpCode` column of type `nvarchar(10)`. No employee bulk import or source synchronization is planned. Every source operation is read-only and uses parameterized queries.

| Source field | Application use |
|---|---|
| `EmpCode` | Employee identifier and login input; preserve text and leading zeros |
| `PersonFNameEng`, `PersonLNameEng` | Display name when available |
| `PersonFNameThai`, `PersonLNameThai` | Display-name fallback |
| `PostNameEng` | Job-title hint in lookup results |
| `OrgID` | Source department hint; no automatic PCN permission grant |

The source has no email address or enabled/disabled flag. A current source record permits sign-in; first sign-in creates an active, roleless PCN SQL account with provider `employee-code`. PCN records remain inaccessible until an administrator assigns a PCN role and department. Source department/job fields do not assign roles or access. Email recipient lookup remains the separate Power Automate integration.

Employee-code-only login deliberately allows anyone who knows an enabled employee's code to sign in as that employee. This is the user's chosen access model; it does not prove identity through a password, AD or Windows SSO.

Existing roles remain `admin`, `reviewer`, `supplier`, `gsc`, `productionengineering`, `qa` and `tapbu`. PCN department choices remain `gscTet`, `prodEngTet`, `qaTet`, `gscTapbu`, `qaTapbu`, `it` and `other`. The local migration-004 feature adds one explicit signing step and a verified directory email per user, automatically deriving the matching mail recipient list. See [mail routing](mail-routing-design.md). Employee lookup never assigns permissions automatically. Migration 004 was applied at `2026-10-07T04:56:51.338Z`, preserving all four users and existing role assignments without adding signing grants. The new code runs locally; its server deployment remains pending.

## Runtime and API contract

`AUTH_MODE=employee-code` is the normal default. `AUTH_MODE=password` is an explicit maintenance option for unlinked legacy password accounts. Windows mode, Windows proof headers, the AD helper, the IIS identity module and Windows login routes are removed from the replacement runtime.

The normal login page accepts one employee code without a password. Codes stay strings, preserving leading zeros. The backend verifies current source presence, creates a roleless PCN account if needed, and issues its normal session. Protected requests revalidate the source and PCN account/session state. Source unavailability fails closed with 503; it does not fall back to AD or password mode.

| Endpoint | Replacement contract |
|---|---|
| `GET /api/auth/config` | Public auth mode and whether employee provisioning is configured; no credentials or source infrastructure |
| `POST /api/auth/login` | In employee-code mode, `{employeeCode, remember?}`; no password or Windows identity input |
| `GET /api/admin/employees?query=...` | Administrator-only bounded employee-code/name search against the SQL source |
| `POST /api/admin/users` | Administrator selects `{employeeCode, roles, department, signingStep, mailSelection?}`; server re-queries the employee source and selected directory mail |
| `PATCH /api/admin/users/:id` | Complete `{roles, department, signingStep, isActive, version, mailSelection?}` assignment edit; stale versions conflict and sessions are revoked |
| `POST /api/admin/users/:uuid/employee` | Explicit link with `{employeeCode}`; selected source record is verified server-side |
| `POST /api/auth/logout` | Revoke the SQL session and clear the cookie, retaining origin/CSRF protection |

The `/employee` link route replaces the former AD `/directory` link route. Cookies remain HttpOnly / SameSite with Secure enabled in production. Mutations retain exact-origin and CSRF checks, role authorization and login throttling. Logout skips the source lookup so it remains available during a source outage.

## Schema and existing accounts

[003_employee_code_auth.sql](../sql/migrations/003_employee_code_auth.sql) was applied on SQL Server 2014 / `Scn_DB` at `2026-10-07T03:35:30.942Z`. Migrations 001/002 were unchanged. For another installation, apply the reviewed migration before selecting this release. Startup validates schema but performs no DDL; runtime ZIPs exclude migrations. The source database/table is never altered by this migration.

Migration 003 adds an explicit identity provider. Existing password users remain `password`; former AD-mapped users become `retired-windows`, receive new security stamps and have outstanding sessions/account tokens revoked. Former AD SamAccountName mappings do not become enabled employee-code accounts automatically.

A verified, explicit source-code link preserves the existing PCN user ID, roles and PCN ownership, clears obsolete AD fields/password state, establishes provider `employee-code` and revokes prior sessions. Conflicting mappings are rejected instead of merged. For this rollout the user confirmed code `2205529`, verified as WATCHARAPHONG BANYEN in the source. A separate Administrator / IT account was created; the unrelated former AD administrator was not relinked. The previous three PCN accounts were preserved, giving four accounts in total.

Migration 002 was previously applied on 2026-10-07 with the original two users preserved and one explicitly selected AD administrator added. Before 002, a DPAPI-encrypted logical export covered 22 PCN tables / 108 rows. Before migration 003, another protected DPAPI logical export covered 22 PCN tables / 121 rows; decryption and SHA-256 were verified. The SQL login lacked native `BACKUP DATABASE` permission. These exports are not native database backups, and a full restore was not tested.

## Reviewed IIS and service cutover procedure

1. Pause the `SupplierPCNTestDeployment` polling task before publishing/selecting the replacement runtime; preserve its protected trust anchors and current release/configuration records.
2. Confirm read-only source access and the administrator's intended source code. Preserve PCN data and the previous service/IIS configuration; apply migration 003 and verify schema readiness.
3. Create a separate Administrator / IT account for verified employee code `2205529`. Preserve existing user IDs, roles and ownership; do not import all source employees.
4. On **PCNTest only**, enable Anonymous Authentication and disable Windows Authentication. Archive/remove the old IIS Windows identity module and its separate proxy-key setup. Keep the HTTPS binding, certificate, other sites and backend SQL credentials protected.
5. Keep Node exclusively on loopback. Retain the ordinary IIS rewrite rule overwriting `X-PCN-Client-IP` with server-observed `REMOTE_ADDR`; no AD identity headers establish application access. Set normal `AUTH_MODE=employee-code` and remove obsolete AD/Windows auth settings from the protected backend environment.
6. Validate the signed replacement release and protected deployment consumer before switching. Verify SQL/source readiness, the exact Node/WinSW owner and loopback listener, then real employee-code login/session/authorization/logout through HTTPS.
7. Record the actual release and test results, then resume the polling task only after the reviewed cutover succeeds. This rollout completed the steps; acceptance is recorded below. The user's own Edge GUI remains unobserved.

The existing NetworkService service identity and service-SID ACLs need not be weakened for this change. SQL/source credentials remain server-side and outside Git/releases. The VPN extension incident belongs to the former Windows-challenge path; normal employee-code login does not issue that native authentication challenge.

## Acceptance — 2026-10-07

- Signed [pcn-test-10-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-10-1) from main `c827d9c1c23c27631604936807dbbc352101c11e` was installed at observed server time `2026-10-07T03:42:57.7868092Z`. [Actions 37567205169](https://github.com/akwaa2545-gif/PCN-/actions/runs/37567205169) succeeded with 240 unit/API tests, 59 isolated browser checks and the high/critical dependency-audit gate. Local coverage was 95.85% lines / 89.32% branches / 96.32% functions across 240 tests.
- The separate employee `2205529` / WATCHARAPHONG BANYEN has role `admin`, PCN department `it`, and user ID `9490AB95-92AE-4931-96A8-8D61E245F1B3`. The prior three accounts were preserved without relinking the former AD administrator. The 1,935-row source remained read-only; no bulk import occurred.
- Local real API acceptance passed 26 checks. A real headless browser using the local SQL-backed runtime passed login, Users, employee lookup, role/department controls and logout. These checks created no additional accounts beyond the explicitly approved administrator.
- Real HTTPS acceptance passed 26 checks with CA/IP verification, covering administrator login/session, source-backed lookup, read-only operations and CSRF/logout boundaries. The server no longer issues a Windows `WWW-Authenticate` challenge. These results are separate from the 59 isolated browser checks and do not establish the user's own Edge GUI behavior.
- PCNTest alone now has Windows Authentication disabled and Anonymous Authentication enabled with empty anonymous username / its existing pool identity. The retired module DLL and key were protected/archived and removed from the live site. The existing pool read/execute permissions and native `REMOTE_ADDR` client-IP rewrite remain intact.
- The private environment uses employee-code mode with obsolete AD variables removed; SQL/mail settings were retained. NetworkService owner, WinSW parent and exclusive loopback listener were verified. Default Web Site HTTP :80 still returns 200.
- The polling task was resumed and verified enabled / Ready / LastTaskResult 0. A repeated poll was a no-op after the accepted deployment.

The user's actual Edge session, operational PCN save/signing/linking flows and email delivery remain unobserved. Existing automated coverage is not a claim that those live operational writes were performed.

## Recovery and further checks

Verify leading-zero codes, source-missing/disabled-account denial, first-sign-in assignment notice with no record access, source-outage 503, prior AD session revocation, explicit-link ownership preservation, selected employee creation and real administrator login. Verify password maintenance mode separately, and ensure employee-provider sessions do not become valid through a mode switch. Check CSRF/origin, supplier/reviewer restrictions and mail-routing separation.

If cutover fails, keep the polling task paused and restore a reviewed, schema-compatible application/configuration state. Migration 003 retires old Windows mappings and revokes sessions, so restarting the old release alone does not restore its former login access. Restore or re-provision only the approved account mapping through a reviewed recovery procedure; do not automatically undo schema/data or reactivate every former AD user.

Related: [Windows deployment runbook](windows-test-deployment.md), [GitHub release pipeline](github-deployment.md), [API inventory](sql-server-api-checklist.md), [table mapping](sql-server-table-mapping.md).
