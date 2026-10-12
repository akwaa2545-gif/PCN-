# PCN Local Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators create PCN accounts for employees missing from the employee source, with employee-code-only sign-in and the existing PCN permissions.

**Architecture:** Store manual accounts in `pcn.Users` with explicit provider `pcn-local`. Existing source accounts retain provider `employee-code` and source revalidation; local accounts use PCN account/session state. Preserve the existing global employee-code uniqueness, access controls, verified-mail integration and explicit source-link mechanism.

**Tech Stack:** Node.js 22+, CommonJS, SQL Server 2014, `mssql`, native HTML dialog, Node test runner and isolated Playwright browser tests.

**Spec:** The accepted design and contracts below implement the user's 2026-10-12 request and employee-code-only sign-in choice; existing baseline: [employee-code authentication](employee-code-authentication.md).

## Global Constraints

- Users header has separate **Add role** and **Create user** actions. Add role searches existing employees/accounts, updating a PCN account or provisioning a source employee through the existing assignment flow. Create user manually enters employee ID/full name and includes role selection in the same popup.
- Product controls use plain labels and contain no KEY_Code_DB or identity-provider descriptions.
- Manual employee IDs are exactly seven numeric characters, preserving leading zeros. Full name is required and bounded to 200 characters.
- Roles remain required and use existing allowed roles; department, signing-step and supplier restrictions remain unchanged.
- Login remains employee code only. No password field, new public sign-in mode, automatic local account creation or source-outage fallback.
- Email must be selected from directory results and revalidated server-side. Signing requires verified mail. Sending mail continues through the existing Power Automate workflow.
- Initial implementation prepares migration 006 locally without automatic startup DDL, publication, deployment or commits. The follow-up startup repair below records its explicit application to the configured database.

## Review Focus

- An employee-service timeout is not evidence that an employee ID is absent; local creation must fail with an unavailable message.
- Source and local creation racing for the same code must yield one account and a conflict, preserving all existing accounts.
- Deactivation, role changes or source linking during a slow lookup must not authorize a stale session or grant set.
- A local user appearing later in the source must retain explicit local identity until an administrator links the account.
- Removing the last usable administrator or changing supplier/signing assignments must retain existing safeguards for both employee providers.

---

## Accepted Design

`POST /api/admin/local-users` accepts only `{employeeCode, displayName, roles, department, signingStep, mailSelection}` and returns the existing safe account response with HTTP 201. It calls `AuthService.createLocalEmployee(body, directory, actor, user)`. The server requires an active administrator, same-origin request and CSRF token; callers cannot select an identity provider or supply a password.

Creation verifies that the code is absent from the source and PCN account database, resolves any selected directory mail, and inserts the user, roles and audit event transactionally. Database unique indexes remain the authority for concurrent employee-code, username and verified-email conflicts. Source accounts already present in PCN are edited through Add role.

In employee-code mode, look up the PCN account by normalized code first. An active `pcn-local` account signs in using PCN state; an `employee-code` account still requires a matching current source record. A code with no PCN account follows the existing source lookup and read-only first-login provisioning. An unknown source code does not create a local account. Password maintenance mode does not accept either employee provider.

Local sessions use the existing security stamp, active-account checks, TTL, CSRF and revocation model. Role-bearing local users open Portal; existing server role, ownership, department and signing rules decide available actions. Manually created local users require at least one role; automatically provisioned source viewers continue to have read-only Records access.

The existing explicit source-link action may convert `pcn-local` to `employee-code`. It preserves user ID, PCN ownership/history, roles, department, signing step and verified mail, rotates the stamp and revokes sessions. Conflicting source account mappings return a conflict without merging records or altering the other account.

## Implementation Tasks

### Task 1: Persistence and schema

**Files:** Create `sql/migrations/006_pcn_local_employee.sql` and `test/localEmployeeRepository.test.js`; modify `src/sqlAuthRepository.js` and `src/sqlDatabase.js`; retain existing repository regression coverage.

- [x] Write repository regression tests for local creation, global code/email collisions, transaction rollback, active local updates, last-administrator protection and linking with stable user ID/grants.
- [x] Run the repository tests and confirm the new cases fail before implementation (eight initial failures).
- [x] Add provider-neutral employee-code lookup and transactional local insertion using parameterized SQL and existing audit/mail-routing locks.
- [x] Extend SQL identity and verified-signing-mail constraints to include `pcn-local`, retaining null password/AD identity requirements and existing unique indexes.
- [x] Extend usable-administrator and signing-provider checks to include local users; preserve optimistic version checks and session revocation.
- [x] Rerun the repository tests: 32 passed. Migration is prepared and covered by local checks; no live DDL was run.

### Task 2: Authentication, API and access

**Files:** Modify `src/employeeAccounts.js`, `src/authService.js`, `src/apiRoutes.js`, `src/workflowAccess.js`, `session-client.js`, `records.js`, `app.js`, `src/userMailRouting.js`, `src/notificationUpdates.js`; create `test/pcnLocalAccountsApi.test.js` and `test/pcnLocalAccess.test.js`; retain existing authentication, viewer, routing and notification tests.

- [x] Write regression tests for seven-digit/manual-name validation, administrator/CSRF boundaries, source absence versus outage, local sign-in/session/deactivation, source revalidation and duplicate creation.
- [x] Add tests proving unknown codes never provision local accounts, maintenance password mode rejects local identities and source appearance does not silently convert them.
- [x] Run focused tests and confirm the new behaviors fail (ten auth/API failures and five access/Records failures).
- [x] Implement the explicit local-creation service and endpoint, reusing assignment/mail validation and safe account responses.
- [x] Dispatch sign-in/session checks using stored provider without weakening existing source verification; preserve current principal checks after asynchronous operations.
- [x] Include local providers in verified notification recipients and appropriate employee access guards while retaining all current supplier, signing and ownership rules.
- [x] Rerun focused tests: authentication/API 50 passed, including 16 new cases; access/routing/Records 81 passed.

### Task 3: Users popup and browser journeys

**Files:** Modify `admin.html`, `admin-users.js`, `admin.css`, `test/frontend-users.test.js` and `scripts/user-dialog-e2e.js`; create `test/frontend-local-users.test.js` and `test/helpers/users-page.js`.

- [x] Write frontend regression tests for separate Add role/Create user actions, manual employee ID/full name, role selection retained inside Create user and the exact local-creation payload.
- [x] Run frontend tests and confirm new cases fail (six initial manual-user failures; later name-length and duplicate-error regressions also observed failing before their fixes).
- [x] Reuse the current accessible popup lifecycle, access fields, verified-mail spinner/profile results and bounded result scrolling for both actions.
- [x] Add manual-field validation, edit/link behavior, duplicate/source-unavailable error presentation and cancellation cleanup, with no account-source explanation in the UI.
- [x] Rerun frontend tests: 45 passed, including eight manual-user cases; existing provisioning/edit payloads remain covered.
- [x] Run isolated browser journeys for desktop/mobile creation, required roles, verified mail, errors, edit/link, focus restoration and fixed popup/result layout. Fixtures made eight exact account writes; no SQL, real mail, browser page errors or external requests.

### Task 4: Review and completion

- [x] Run `npm run test:coverage`: 568 passed, zero failed; 91.53% lines, 90.41% branches, 93.77% functions.
- [x] Run `node scripts/user-dialog-e2e.js`, `node scripts/e2e-smoke.js`, `node scripts/login-e2e.js` and `node scripts/records-e2e.js`: all passed with exit 0.
- [x] Obtain code, JavaScript and security reviews. The manual duplicate-message finding was fixed and regression-tested; final reviews found no remaining concrete issues or new high/critical vulnerabilities.
- [x] Record actual verification results below and update the README's account and migration contracts.
- [x] Confirm initial implementation prepared migration 006 without schema changes, deployment or actual notification sends; the later startup repair is recorded below.

## Verification Record

Focused checks reported during implementation: authentication/API **50 passed** (16 new), repository **32 passed**, access/routing/Records **81 passed**, and frontend **45 passed** (eight manual-user cases). These are individual suite results, not a deduplicated whole-project count.

The final dedicated isolated browser run passed, including manual creation, cached-account Add role editing without source configuration, exact payloads, retained error drafts, cancellation, profile loading and desktop/mobile layout. The broad smoke and separate isolated login/Records browser runs also passed with exit 0. Aggregate coverage passed all 568 tests; final code, JavaScript and security reviews passed. Dependency audit found two pre-existing moderate findings in `sprintf-js` through `tedious`; this feature does not change dependencies.

No real mail was sent for the isolated UI/account checks. The signed HTTPS release has not been updated for this feature.

### Startup repair — 2026-10-12

The user's development watcher failed because migration 006 was registered as required but not applied. Read-only inspection confirmed a healthy connection to the configured `Scn_DB`, SQL Server 2014 compatibility 120, and exactly one missing migration: `006_pcn_local_employee.sql`.

After independent review, the guarded repair invoked the existing checksummed, transactional migration runner. It applied only migration 006, without master-data seeding, bootstrap accounts or mail operations. Database readiness changed from false to true with no missing migrations; counts remained 10 users, three PCN records, six role grants and one master-data version. Touching the watched entry file restarted the existing development watcher, and `http://127.0.0.1:3000/api/ready` returned HTTP 200 with `status: ready`.

### Users table and role removal — 2026-10-12

The user requested separate pending-access and assigned-user tables, filters, and a row action to remove roles. Pending access means `roles.length === 0`, independently of active/inactive status; assigned users have one or more roles. Shared search matches name, employee code or email, with PCN role, department and status filters and a clear action. Each group has counts and an empty state; one combined polite summary names both groups. Pending rows offer Add role using the existing versioned assignment editor. Assigned rows offer Edit and Remove role, with confirmation naming the employee and explicitly removing all PCN roles while retaining the account and records.

`DELETE /api/admin/users/:id/roles` accepts only `{version}`. Existing active-administrator, origin and CSRF gates remain mandatory. The dedicated service/repository path validates identity/version and uses the existing serializable transaction, exclusive routing lock and caller stamp/version check. It clears role links, department and signing step, rotates the security stamp, revokes sessions/tokens and audits `account-roles-removed`. It preserves the account's ID, provider, employee code, display name, active state, raw verified-mail fields and PCN ownership/history. Normal creation and assignment PATCH still require nonempty roles.

Missing targets return 404; stale versions, already-roleless accounts and removal of the last active code-based administrator return 409 without partial writes. Inactive accounts remain inactive, and legacy providers are not converted to employee identities. Source/local employee accounts with no roles retain read-only Records access. Signing recipients disappear from current/pending routing; general notifications for records the user owns retain the existing policy.

Focus follows the employee's action across groups after removal or reassignment. If filters hide the row, focus returns to the visible status summary. Tables preserve native cell layout, readable column widths and horizontal scrolling, with accessible Actions placement.

Repository, authentication and UI regression tests were observed failing before implementation. This enhancement requires no new migration and tests do not remove any real account roles or send email.

The user then required Save changes to stay disabled in Edit access when no work email is selected. All edit modes now require a valid retained verified profile or a newly selected directory result, including administrators and legacy accounts without signing steps. Typing an address invalidates the confirmation. Pending accounts cannot save until a role and valid department are explicitly selected. `AuthService.updateEmployee` independently rejects missing, incomplete, plain or explicitly cleared mail after server resolution; Create user, linking and the role-removal endpoint retain their existing rules. This keeps access revocation possible without mail. These regressions were observed failing before their fixes; updated focused results are 64 auth/API and 56 frontend tests passed.

Pending access also has a decorative gold heading dot, gold count badge with dark text and a thin gold table accent. Text labels convey the same status independently of color; assigned styling is unchanged.

Final verification: all 600 tests passed with 91.63% line, 90.81% branch and 93.80% function coverage. The role-removal repository suite passed its 39 focused cases. Code, JavaScript, security and accessibility reviews passed. The updated popup/edit-mail suite, split/filter/removal/reassignment suite and broad browser smoke all exited 0 without browser errors or outbound requests. A separate zero-write visual check verified the yellow pending indicator at 995-pixel desktop and 390-pixel mobile widths. The local server remained ready during implementation.
