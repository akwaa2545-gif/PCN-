# Developer access

Updated: 2026-10-15.

Status: implemented and verified locally. Developer has Administrator-equivalent access and the shared password is required when saving Developer in **access settings**, not during sign-in. Deployment remains on hold until the user explicitly says **deploy**. Runtime `pcn-test-17-1` and its host configuration are unchanged. The Records dashboard checkpoint is also local; neither feature has been released by this work.

## Role and assignment

Developer is stored as the exclusive role `developer`, department `developer`, and no signing-step assignment. It is not stored as `admin` and cannot be combined with another role, department or signing step. Existing employee-backed, PCN-local and eligible password-maintenance accounts can receive this explicit assignment through the normal account-management APIs.

Developer has the same application permission checks as Administrator: Portal, Users, Mail Routing, record management and authorized administrative workflow/signing actions. Existing record versions, terminal locks, signing order, document-control, current-account and session checks still apply. Administrator-equivalent access does not invent completed signatures or bypass validation.

Users supports Developer in Add role, Create user, Edit access and role/department filters. Selecting Developer sets the Developer department, removes the signing-step assignment and reveals an inline masked Developer-password field in the shared access dialog. Profile and access labels display Developer. Existing verified-email and account-creation requirements continue to apply.

Developer is excluded from automatic signing-mail routing because it has no department signing assignment. Existing manually managed Mail Routing remains an administrative capability. Assigning Developer does not automatically make that account an automatic workflow recipient.

The last-active-employee-Administrator guard still counts actual Administrator grants. Developer cannot substitute for the final Administrator; converting or removing that final grant remains blocked. Assignment changes retain the existing session-revocation behaviour.

An account with Developer access must have that access removed before it can be linked to a different employee identity. The server rejects a direct link with HTTP 409 and makes no writes. The supported sequence is Remove role, link the employee, then reassign Developer using the shared assignment password. SQL password-maintenance account creation also revalidates the trusted acting account under the shared assignment lock.

## Protecting existing Developer accounts

Only an active account with the valid exclusive Developer assignment can edit access, deactivate, demote or remove roles from an existing Developer. Administrator attempts receive HTTP 403 before password/mail work, and the SQL transaction repeats the check against the current target after validating the acting session under the assignment lock. Target promotion races and stale forms cannot bypass it. The Administrator UI disables Edit, Remove role and identity linking for these accounts. Identity linking already rejects any current Developer until its role has been removed by an authorized Developer.

Administrator creation of a new Developer grant remains available with the required assignment password. A Developer retaining an existing Developer assignment must still enter that password. Authorized demotion/removal still requires no assignment password; existing revocation and last-Administrator safeguards remain.

## Password verification in access settings

Every Add role, Create user or Edit access save whose resulting assignment is Developer requires the shared Developer password. This includes editing an account that already has Developer and retaining that assignment. The server verifies the password before persisting the assignment; a browser flag or previously successful save cannot substitute for verification.

Missing or incorrect password returns HTTP 400 and changes no grant. The dialog retains the employee selection and other draft fields so the administrator can correct the input. The password field clears after each save attempt, cancellation, role change or account change. It is not stored in user profiles, preferences or browser storage. Removing Developer or saving a demotion to another role requires no Developer password; normal authorization and last-Administrator safeguards still apply.

The password is shared private configuration for this installation, not a password saved on each PCN user. It protects Developer assignment changes.

## Normal sign-in

Source-backed Developer accounts sign in with their employee code and retain current employee-source verification. PCN-local Developer accounts use normal local employee-code sign-in. Eligible password-maintenance accounts require only their ordinary account password. Developer sign-in requests no shared Developer password.

Existing account, session, security-stamp and revocation checks continue to apply. Changing the shared assignment password does not introduce a new requirement for existing Developer users to sign in again. Missing assignment-password configuration does not disable their normal sign-in.

## Private configuration

`PCN_DEVELOPER_PASSWORD_HASH` contains only the encoded Argon2id hash of the shared Developer assignment password. Set it through protected process configuration or the installation's private environment file, never through browser responses, source, release archives or committed examples. [.env.example](../.env.example) intentionally leaves the value blank. No password or real credential hash is included in this document.

The current configuration validator accepts Argon2id version 19 with memory cost 65536 KiB, three iterations, parallelism one, a 16-byte random salt and a 32-byte digest. The encoded iteration and parallelism fields may appear in either order after the memory field, including the order generated by the production password hasher; costs and lengths must still match exactly. Generate a fresh hash with the project's Argon2 library using those parameters, then store it directly in private configuration. Do not print or save the plaintext password in commands, logs or documentation. An arbitrary encoded hash with different parameters is not accepted by this validator.

Missing, blank or malformed hash configuration prevents granting or retaining Developer in access-setting saves. It does not block normal sign-in for an existing Developer account or require the password for Developer removal/demotion. The public authentication configuration exposes the sign-in mode, not the hash or shared credential. Apply a reviewed private configuration change and restart the local process when changing its environment.

The Developer hash was configured in the ignored local environment file after masked-input password hashing, real password verification and configuration validation succeeded. A fresh child process loaded the local environment and confirmed valid Developer configuration without printing any password or hash. This local setup applies no migration and grants no account access. The committed template remains blank. No host configuration, certificate or HTTP change is part of this feature.

## Database prerequisite

[007_developer_role.sql](../sql/migrations/007_developer_role.sql) seeds `developer` in `pcn.Roles` only when absent. It grants no user access and contains no table/column change. It is appended to the migration manifest; existing migration files and checksums are unchanged.

**Migration 007 is now applied** to the configured `svr120a / Scn_DB`, following the 2026-10-15 local startup repair below. At the initial implementation checkpoint it was prepared but unapplied; SQL-backed source correctly refused startup while that required migration was missing. Providing the private password hash alone did not satisfy the schema prerequisite. Startup and deployment do not silently run migrations. The repair seeded the role catalog and migration metadata without assigning Developer access or changing PCN business data.

## Local startup repair — 2026-10-15

After the local watcher reported SQL-backed startup failure, read-only preflight confirmed SQL connectivity and SQL Server 2014 version `12.0.6449.1`, compatibility level 120. Applied migrations 001–006 matched their source checksums; **007 was the only missing migration**, making schema readiness false.

The guarded existing `applyMigrations` runner applied only `007_developer_role.sql`: the Developer role catalog seed and its `SchemaMigrations` metadata. The broad database-migrate command, master-data seeding and administrator bootstrap were not run. No table/column DDL was introduced. Post-repair checks confirmed all seven migration checksums valid, the Developer role present and SQL schema readiness true.

Before/after counts were unchanged: **10 users, 3 PCNs, 4 user-role grants and 1 master-data version**. No account received Developer access, and no mail was sent.

Only `server.js` modification time was touched to wake the existing Node watcher; file contents were unchanged. Watcher PID 23628 restarted its child as PID 23812, which listened on port 3000. `GET http://localhost:3000/api/ready` returned HTTP 200 with `ready`. This repaired local startup; it did not push source, deploy an application or modify the host application/runtime. Signed host runtime `pcn-test-17-1` remains unchanged.

## Source map

| Source | Responsibility |
| --- | --- |
| [src/authConfiguration.js](../src/authConfiguration.js) | Private hash-format validation |
| [src/authService.js](../src/authService.js) | Server-side assignment-password verification before saving Developer access |
| [src/apiRoutes.js](../src/apiRoutes.js), [src/authHttp.js](../src/authHttp.js) | Protected access-setting routes and existing authorization/session checks |
| [src/employeeAccounts.js](../src/employeeAccounts.js), [src/signingPermissions.js](../src/signingPermissions.js), [src/workflowAccess.js](../src/workflowAccess.js) | Exclusive assignment and Administrator-equivalent permission checks |
| [src/sqlAuthRepository.js](../src/sqlAuthRepository.js), [src/sqlDatabase.js](../src/sqlDatabase.js) | Stored assignments, actual-Administrator safeguards and migration manifest |
| [login.js](../login.js), [login.html](../login.html) | Normal employee/local/maintenance sign-in without a Developer challenge |
| [admin-users.js](../admin-users.js), [admin.html](../admin.html), [session-client.js](../session-client.js) | Inline access-setting password, user management, filters and profile labels |
| [scripts/developer-role-e2e.js](../scripts/developer-role-e2e.js) | Isolated Developer browser acceptance |

## Verification

```powershell
npm run test:coverage -- --test-concurrency=4
npx playwright install chromium
npm run test:developer-role
npm run test:e2e
```

The corrected assignment-only implementation passed **736/736 tests** with exit code 0 and **92.08% line, 91.24% branch and 93.85% function coverage**, using the bounded-concurrency command above on Windows.

All **eight isolated Developer browser groups passed**, with zero browser errors, external calls or forbidden writes. They covered Create/Add/Edit verification, retained Developer assignments, wrong-password draft preservation and no writes, secret clearing, throttled attempts, exact role/department storage, password-free demotion/removal, normal source/local/maintenance sign-in, Administrator API authority, session stability across assignment-hash rotation/service restart and credential exclusion from account/browser storage. Test accounts and passwords were isolated in memory. Desktop and 390-pixel Edit access screenshots were visually inspected.

JavaScript/TypeScript, general code and security reviews approved the corrected implementation with no HIGH or CRITICAL findings. Local `GET http://localhost:3000/api/ready` returned `ready` after the source changes. The final ordinary-login regression passed all **eight groups** with exit code 0. The dependency audit found zero high/critical issues and the same two pre-existing moderate issues; no dependencies changed.

The final full-application smoke run passed **120/120 checks** with exit code 0: seven email, sixteen signoff, eighteen unsaved-document and seventy-nine main application checks. This includes native unsaved-change protection; fixture/browser/server cleanup completed. Reviewed harness changes verify the conditional Developer password input is hidden, disabled and empty during ordinary sign-in, and add bounded fixture waits and diagnostics. An earlier stalled run's cause was not established; the successful final run supplies the acceptance evidence.

Migration 007 application and local readiness evidence above remain valid independently of this password-flow correction. The Developer hash remains configured only in the ignored local environment file. No source push or application deployment was performed.


## Existing-account protection verification

The follow-up service, locked SQL, API and UI tests verify Administrator refusal for current Developer edits, deactivation, demotion, role removal and identity-link controls. Authorized Developer management, new grants and assignment-password checks remain covered. All 105 focused checks and nine isolated Developer browser groups pass; the combined full-suite results are recorded in `plans/create-pcn-experience.md`. No operational account, role or mail data was changed, and no deployment occurred.
