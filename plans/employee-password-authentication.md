# Employee Password Authentication Implementation Plan

Updated: 2026-11-20. Local implementation and approved database/mode activation complete.

**Goal:** Keep employee codes as the login identifier, require an employee-chosen password, support first-use password setup and profile password changes.

**Architecture:** Add an explicitly activated `employee-password` authentication mode while retaining existing modes during staged rollout. Employee account IDs, providers, roles and ownership remain unchanged. Persist session authentication methods so a passwordless session cannot become a password-authenticated session. First-use sessions permit password setup only.

**Tech stack:** Existing Node/CommonJS, browser JavaScript/native forms, Argon2id, SQL Server 2014 and Playwright.

## Confirmed user requirements

- Sign in using the employee code and a password.
- On first use, let the employee set their own password before entering the application.
- Add Change password to the profile menu shown in the user's screenshot.
- Passwords are exactly eight characters; all letters, all numbers or a mix are accepted. No mixed-character requirement. The implementation accepts ASCII letters/digits.
- Preserve current users, role/department/signing assignments, document ownership and the separate Developer assignment secret.

## Flow and boundaries

1. In `employee-password` mode, the login page accepts employee code and an optional existing password. First-time help explains leaving the password blank to start setup.
2. Source employees are verified against the current employee directory; PCN-local employees retain their local identity checks. Missing, inactive, conflicting or unavailable identities fail closed.
3. An account without a password receives only a ten-minute `password-setup` session. It cannot read PCNs, profiles or administrative data, perform signing, or create documents. Remember-me does not extend setup.
4. The setup screen asks for an eight-character password and confirmation. A compare-and-set write creates its Argon2id hash, records the enrollment time, rotates the security stamp and revokes all sessions/tokens. The employee then signs in normally.
5. Enrolled accounts receive a full `employee-password` session only after password verification. Code-only requests never receive full access in this mode. Existing old-method sessions are rejected.
6. Change password requires the current password, new password and confirmation. It applies the same eight-character rule, rejects unchanged passwords, revokes other sessions and returns the user to sign-in.

No password is logged, returned by APIs or saved in browser storage. Existing same-origin, CSRF, throttling, account-lockout, employee revalidation and permission checks remain enforced. The existing password-only maintenance mode retains its behavior.

First enrollment retains the existing employee-code/source trust model: knowing a valid, unenrolled employee code permits choosing its first password. It does not add an email/OTP or separate identity-verification channel. Once enrolled, the new mode requires the password. An older deployed runtime sharing the database continues its existing code-only policy until that runtime is upgraded/configured; method binding prevents its cookies from granting full access in the new runtime.

## API and service contracts

| Endpoint | Contract in employee-password mode |
| --- | --- |
| `POST /api/auth/login` | `{employeeCode,password?,remember?}`; normal session or restricted setup session |
| `GET /api/session` | Setup principals include `user.passwordSetupRequired:true` and `mustChangePassword:true`; full principals include `user.canChangePassword:true` |
| `POST /api/auth/setup-password` | Restricted setup session only, exact-origin/CSRF, `{newPassword,confirmPassword}`; returns `{authenticated:false,passwordSet:true}` |
| `POST /api/auth/change-password` | Full password-authenticated session, including roleless employees; `{currentPassword,newPassword,confirmPassword}`; returns `{authenticated:false,passwordChanged:true}` |

`AuthService` gains `setupPassword(token,body)` and record-aware session-purpose checks. `SqlAuthRepository.updateEmployeePassword(id,hash,newStamp,expectedStamp,{firstSetup})` atomically validates provider/active state/enrollment state and rotates/revokes credentials. `saveSession` accepts optional `authenticationMethod`; legacy writes omit the new column until rollout. Session and user hydration tolerate missing optional columns before activation.

## SQL migration 010 and activation

Prepare `010_employee_password_auth.sql` without applying it during implementation. Add `Users.PasswordSetAt` and `Sessions.AuthenticationMethod`, and relax the old employee-password-null check only into a strict hash/enrollment-time pairing. Preserve the identity/AD/verified-mail safeguards. Old relink operations cannot silently clear an enrolled password. No bulk employee import, assigned password, staff-grant change or document mutation.

Before activation, complete implementation, tests and independent reviews. Then request approval for the concrete migration and local `AUTH_MODE=employee-password` switch. Baseline startup remains usable before that operational step. New-mode startup requires the applied migration and verified schema; it never executes DDL automatically. Signed remote deployment remains separate.

## Tasks and ownership

- [x] Root: mode helpers/configuration, API setup-only gate and endpoints, HTTP integration tests, runtime readiness integration, documentation and final activation preparation.
- [x] Authentication worker: `src/authService.js`, password validation, new-mode identity/password/session/setup/change flows and service tests. Preserve old-mode tests and semantics.
- [x] SQL worker: `src/sqlAuthRepository.js`, prepared migration010, SQL adapter tests, safe session persistence and atomic credential compare-and-set.
- [x] Login worker: `login.html`, `login.js`, existing `auth.css`, first-use/password forms, eight-character validation, existing modes and redirect semantics, frontend tests.
- [x] Profile worker: `session-client.js`, narrowly scoped `styles.css`, profile Change password dialog, roleless access and frontend tests.
- [x] Browser validation: isolated employee-password setup/login/change flows, numeric/letters/mixed passwords, wrong credentials, setup-only denial, session revocation, leading zeros, desktop/mobile and keyboard behavior.
- [x] Independent code, JavaScript, security and database review; appropriate tests and coverage before proposing activation.

Each implementation task starts with failing behavioral tests and reports passing focused checks. Workers share the workspace and must not revert others' work. No live passwords, account grants or business records are changed by isolated tests.

## Verification

- Full suite: **1,250 tests passed**, zero failures; **89.07% line / 91.88% branch / 94.67% function coverage**. Evidence: `test-results/employee-password-coverage.log`.
- Service/account/current-password races, SQL CAS/rollback, old session rejection, setup-only API denial, origin/CSRF, roleless self-service, frontend secret clearing and stale-login/password-change responses have focused behavioral regressions. Auth service coverage is 98.23% lines; password helpers are 100%.
- Seven isolated browser journeys passed in three complete runs with actual Argon2id hashing, synthetic employee/local/admin/Developer/roleless accounts and no SQL or external requests. Desktop/mobile screenshots were inspected. Evidence: `test-results/employee-password-browser-final.log`, `employee-password-report.json` and `employee-password-*.png`.
- Independent code, JavaScript, security and database reviews have no remaining actionable findings. Review found and fixed a packaged-startup dependency on excluded SQL files: readiness now embeds the reviewed migration checksum, tests compare it to the SQL source, and an isolated runtime test runs without filesystem/migration resources.
- Migration010 SHA-256: `eb4c9a16e37257c3157927a1c9959ccde113011b2ee830f4189f329793fba677`. New-mode readiness verifies this metadata, typed/nullable columns and enabled/trusted credential/session constraints. Runtime archives continue to exclude migration SQL.
- The existing local server remains ready with `AUTH_MODE=employee-code`; no live password enrollment, schema update, auth-mode switch, user-grant change, PCN mutation or test mail was performed.
- Compatibility browser checks also pass: eight legacy login groups and seven legacy profile groups. The profile check exposed an existing broad navbar-avatar rule; it now targets only the navbar trigger, preserving the compact 44px trigger/40px avatar while restoring the intended 84px popup photo (72px on mobile). The harness's stale navbar-size expectations were corrected without weakening popup-photo or functional checks. Evidence: `test-results/employee-password-legacy-login.log` and `employee-password-legacy-profile-fixed.log`.

## Activation completed — 2026-11-20

The user explicitly approved migration010 and the local mode switch. The guarded runner verified the exact `SVR120A / Scn_DB` target, all nine existing migration checksums and the pinned010 checksum. It applied only010 plus its metadata inside a serializable transaction with the schema migration lock, verified the new credential/session schema, and committed at `2026-11-20T03:36:32.154Z`.

Before/after checks retained **13 PCNs, 10 users, 4 role grants, 1 master-data version, 1 mail-settings row, 1 workflow-settings row and 109 audit rows**. PCN versions, user account/access-version/security-stamp snapshots, grants and daily counters were identical inside the transaction. No passwords were assigned, accounts enrolled, users bootstrapped, data seeded or test mail sent. Evidence: `test-results/employee-password-010-activation.json`; narrow operation: `test-results/activate-employee-password.cjs`.

The private local environment file was backed up with matching ACLs; only `AUTH_MODE=employee-code` changed to `AUTH_MODE=employee-password`. Other settings and source-file permissions were preserved. Migration010 is now registered as the append-only tenth manifest entry. Its registration regression was observed failing before the change, then passed; **56 targeted tests passed**, and independent activation security/code/JavaScript reviews approved the runner and registration.

The existing development watcher restarted its child process. The live SQL adapter reports `{ready:true,migrations:10}` and the password schema check passes. `/api/auth/config` reports `employee-password`; `/api/ready` returns HTTP200. A clean, read-only browser context verified visible employee-code/password sign-in, an unauthenticated session and HTTP401 for PCNs, with zero account enrollments, business writes, runtime errors or external requests. Evidence: `test-results/employee-password-local-enabled.json` and `.png`.

Employees now sign in again and choose their own password on first use; already-enrolled employees supply it normally. Signed remote deployment remains a separate action; this local switch does not update the older deployed site's runtime.

## Login password controls and Remember me — 2026-11-20

The employee-password sign-in screen now uses a bordered 54px password field with a decorative lock, visible keyboard focus and a native Show/Hide button. The password remains masked by default and is cleared/re-masked after attempts, setup transitions, reconfiguration and pagehide. Pending requests disable both the visibility control and Remember me without overwriting the toggle label.

Remember me is unchecked by default. Selecting it sends `remember:true` through the existing login API and requests the existing 30-day full session; leaving it unchecked retains the eight-hour default. First-use setup remains limited to ten minutes even when selected. No passwords or employee codes are persisted in browser storage by these controls, and no database/configuration change was needed.

Tests observed the new behaviors failing before implementation. The focused login/Developer set passes 44 tests, and the complete suite passes **1,254 tests** (`test-results/login-password-controls-full.log`). Nine isolated real-browser journeys verify visibility/value preservation, keyboard checkbox behavior, retry/pending state, actual server and cookie expiry, and control bounds at 1440px, 390px and 320px. Evidence: `test-results/password-controls-browser-final.log` and `employee-password-login-controls-*.png`. A clean read-only local browser check also confirmed the updated controls are served without submitting credentials or creating an account.

## Eight-circle employee password entry - 2026-11-20

The employee sign-in password now displays eight circular indicators. One labeled native password input still handles letters, digits, editing, selection, paste and password-manager autocomplete. Decorative circles are excluded from the accessibility tree and contain no password characters while masked. Show/Hide sits above the row; reset, pending requests and pagehide retain the existing masking/clearing behavior. Remember me and session limits are unchanged. Forced-colors mode displays the ordinary native field with visible text, caret and selection.

The circle regression failed before implementation. The focused login/Developer set passes **45 tests**, and the complete suite passes **1,255 tests** (`test-results/password-circles-focused.log`, `password-circles-full.log`). Independent code and JavaScript reviews approved the change; accessibility review recommendations for visible high-contrast selection and the eight-character helper were applied. Ten isolated browser groups pass with no runtime errors or external calls, including clipboard editing, Show/Hide, pending/reset behavior, desktop/mobile bounds and forced colors (`test-results/password-circles-browser-final.log`, `employee-password-circles-*.png`). A clean localhost check confirms eight empty circles without any authentication POST or real account enrollment (`password-circles-localhost-*.png`).

### First-use setup fields

New password and Confirm password on the setup page now use the same eight-circle design and independent Show/Hide buttons. A shared controller keeps a single native input per field, retains required eight-character validation and new-password autocomplete, and clears/remasks both native values and decorations after mismatch, error, successful setup and pagehide. While setup is pending, both fields and their visibility controls are masked and disabled; the existing setup request and session behavior remain unchanged.

Both new setup regressions failed before implementation. The focused login/Developer checks pass **47 tests**, and the complete suite passes **1,257 tests** (`test-results/setup-password-circles-focused.log`, `setup-password-circles-full.log`). Independent code and JavaScript reviews approve the shared controller. Setup screenshots at desktop, 390px and 320px and forced colors were inspected (`test-results/employee-password-setup-circles-*.png`); all **12 isolated browser groups pass** with zero runtime errors or external calls (`setup-circles-browser-final.log`).

## Employee ID first - 2026-11-20

The current employee-password screen initially shows only Employee ID and Continue. A valid seven-digit input automatically checks the account once. First-time users go straight to the existing limited password-setup session. Enrolled users see the password circles and Remember me expand, with focus on the password; password sign-in remains manual. Continue supports prefilled IDs and explicit retry without an automatic retry loop. Editing the ID clears the previous challenge, password, visibility and Remember me state. After successful setup, the known ID is retained and password entry expands with the green success notice.

The explicit identification request is `POST /api/auth/login` with `{employeeCode,identifyOnly:true}`. For an enrolled account it returns only `{authenticated:false,passwordRequired:true}`, without a new cookie, token, profile, session, password-hash verification or failed-password counter change. Unset credentials receive the existing ten-minute setup session. The flag is true-only, cannot be combined with password/remember, is unavailable on the admin alias or other auth modes, and retains origin, active-account/source, IP throttling, lockout and credential-pair checks. Both identification and password submission count toward the existing sign-in request limit. Normal password login behavior is unchanged. Frontend requests are serialized; captured-code/request-generation checks and pagehide invalidation prevent stale replies from changing the active step. A persisted pageshow reloads authentication state. Continue also synchronizes the current ID so delayed autofill change events cannot duplicate identification.

Frontend and backend regressions failed before implementation. The focused frontend/Developer set passes **52 tests** and the broader backend auth set passes **82 tests**. The full suite passes **1,270 tests**, with **89.23% line / 91.96% branch / 94.69% function coverage** (`test-results/employee-entry-coverage.log`). Independent code, JavaScript and security reviews approve the change. All **14 isolated browser groups pass**, with no runtime errors or external requests (`identifier-first-browser-complete.log`, `employee-password-identifier-first-*.png`). Actor journeys reset only the synthetic in-memory IP-attempt tracker at their boundaries because all test actors share one loopback IP; production limits remain active and their boundary has dedicated unit coverage. A read-only localhost check confirms the initial ID-only screen and HTTP200 readiness without credential submissions (`identifier-first-localhost-report.json`, `identifier-first-localhost-*.png`). No migration, configuration, real-account enrollment or business-data change is needed for this flow.

## Password motion and automatic sign-in - 2026-11-20

Password expansion now has a 280ms slide/fade reveal; setup heading and form enter together over 320ms. Filled circles pop briefly over 180ms. These animations use opacity/transform, preserve immediate input and focus, and are disabled for reduced motion. Four intercepted browser cases at desktop and 320px verify actual frame progression, stable reveal timing across busy states, final bounds and reduced-motion behavior (`test-results/auth-animation-browser-report.json`, `auth-animation-*.webm`).

The latest flow signs in automatically when a native input/change event completes eight valid letters/digits for the identified employee. The help text announces this behavior before entry. Remember me must be selected before completing the password; manual Sign in remains available for event-free autofill and deliberate retry. Setup/confirmation fields still require Set password. Duplicate events, pending requests, hidden forms, invalid values and cleared fields cannot trigger another attempt. Raw/combined paste validation prevents an overlong value from being truncated into an unintended automatic attempt.

Failed attempts clear and re-mask the password and require deliberate re-entry or manual retry. All lifecycle reset paths also discard the tracked previous password, including pagehide during an in-flight request. New automatic-entry regressions failed before implementation, then the **55 focused login/Developer tests passed** (`test-results/auto-password-red.log`, `auto-password-focused.log`). Independent code, JavaScript and security reviews approve the implementation. The browser harness now keeps partial-entry UI checks separate from held-response automatic-entry checks and requires real automatic submission in its page object (`scripts/helpers/employee-password-browser.js`).

Final verification passes **1,273 tests**, with **89.25% line / 91.99% branch / 94.78% function coverage** (`test-results/auto-password-coverage.log`). All **16 isolated browser groups pass**, with zero runtime errors or external calls (`automatic-password-browser-green.log`, `employee-password-report.json`). Desktop and 320px pending screenshots were inspected, and a read-only localhost GET confirms the automatic-entry hint without submitting credentials (`automatic-password-localhost-hint-report.json`).

## Standard Microsoft Edge sign-in — local follow-up, 2026-11-24

At the user's request, employee-password sign-in shows the original seven fixed Employee ID boxes and a normal masked password field together, with Remember me and an explicit Sign in button. The ID boxes use one native username input with the existing seven-digit limit and autocomplete metadata. Completing seven digits or restoring a valid autofilled ID automatically sends an ID-only account check. First-time users enter the existing restricted password setup flow; enrolled users stay on the password form and still select Sign in to authenticate. No password or Remember me option is included in the automatic check. This supersedes the ID-first password-field expansion and automatic eighth-character credential submission described above. Legacy employee-code mode retains its existing code-only behavior.

The form uses stable username/current-password autocomplete metadata and explicit POST actions. First-use setup includes the matching readonly username for password-manager association without adding that field to API JSON. Cold-page autofill and verified credentials remain in their native inputs through successful navigation; failed requests, account changes and page exit still clear passwords. Authentication, CSRF, cookies, eight-character password policy and session durations are unchanged. No password storage was added.

Test-first regressions passed 54 frontend checks, and the complete unit/API suite passed 1,354 tests with 90.09% line, 91.81% branch and 94.98% function coverage (`test-results/auto-account-check-final-coverage.log`). The adapted employee-password browser gate passed 19 groups, including automatic first-use setup and fresh Chromium/Edge desktop/mobile form handoff. Four final focused browser cases also verify that ID-only checks preserve autofill and focus on Remember me or Show password while credential submission remains manual (`test-results/password-manager-focus-browser-green.log`). The Employee ID hint now uses the requested "Your Employee Number" text. These checks model autofill and browser-form behavior; they do not establish a particular user's native Save password prompt or enterprise password-manager policy. Code, JavaScript, security and accessibility reviews approved the changes.

The seven-box Employee ID restoration was then verified with 53 frontend tests and four focused Chromium/Edge desktop/mobile cases. They check visible boxes, leading-zero autofill, normal password visibility, explicit submission and native form handoff (`test-results/employee-id-boxes-final-green.log`, `password-manager-pin-browser-green.log`).

This follow-up is local only. The user explicitly requested no deployment or push; signed runtime 25 remains unchanged.
