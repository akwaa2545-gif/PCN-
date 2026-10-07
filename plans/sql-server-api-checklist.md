# SQL Server API inventory and checklist

Updated: 2026-10-07. Sources: `src/apiRoutes.js`, `src/httpServer.js`, auth, workflow and integration modules. Main `9f23256` is deployed in signed release pcn-test-8-1. [Actions 37559651975](https://github.com/akwaa2545-gif/PCN-/actions/runs/37559651975) passed 243 tests, 59 isolated browser checks and the dependency audit gate. Twelve real Windows-client SSPI/TLS checks passed before and after the release restart; actual browser GUI sign-in and email delivery remain unverified.

Setup status: SQL2014-compatible migration applied on `svr120a / Scn_DB`; master-data version 1 and forced-change `itadmin` account created. Seven routing groups were initialized empty. Real SQL smoke checks and isolated browser E2E passed. Current deployment evidence is recorded in [the Windows runbook](windows-test-deployment.md). Existing Firebase data import remains pending.

Department/action routing-v2 is on main and deployed in pcn-test-8-1. See [routing design](mail-routing-design.md). It adds no DDL; live routing saves and notification delivery were not exercised by the Windows sign-in checks.

Migration 002 is applied on `svr120a / Scn_DB`. The original two users remain, and only the selected SamAccountName `2172172512501` was provisioned as Administrator / IT. Windows sign-in, own AD lookup, administrator reads, header overwrite, password denial and CSRF/logout checks passed against the deployed IIS/NetworkService backend. See the [Windows-authentication runbook](employee-windows-authentication.md) for exact evidence and rollback; no bulk employee import occurred.

## Shared contract

- JSON success: `{success:true,data}`; errors: `{success:false,error,details?,code?,requestId}`. Download returns file bytes.
- Sessions expose safe user/roles, CSRF token and expiry, never password hashes or session-token hashes.
- Except health/readiness/login/session/logout, routes require a SQL session. Force-change accounts can access only password change.
- Mutations require the configured origin and `X-CSRF-Token`. Login requires the origin; logout checks CSRF when authenticated.
- PCN update/delete/comment/approval requires a fetched 16-character hex `version`; stale versions return 409. PUT and PATCH both merge PCN updates.
- Suppliers are scoped by `ownerUserId`; internal roles currently see broader records. Company membership/assignment scope is pending. Actors/roles are server-derived.
- Parent/children/review/audit changes are transactional. Local policy 2 commits eligible mail jobs in the PCN save transaction; legacy policy 1 retains a separate compatibility enqueue.
- JSON limit is 1 MB; file upload has a separate 15 MB JSON cap and 10 MiB decoded limit.
- Errors include 400 invalid input, 401 no session, 403 denied, 404 unavailable record, 409 conflict, 413 excessive body, 423 unscanned download, 429 login throttling, 503 readiness/configuration failure. Unexpected backend failures return generic 500.

## Implemented endpoints

PCN API identifiers are canonical `PCN-YYYY-NNNN`; browser alias normalization is separate.

| Method and path | Behavior / permission | Limitation or check |
|---|---|---|
| `GET /api/health` | Public process liveness | Does not test SQL |
| `GET /api/ready` | Public schema/table/master readiness | SQL unavailable returns 503 without SQL details |
| `GET /api/auth/config` | Public local auth-mode/provisioning capability | `{mode,employeeProvisioningConfigured}`; no private domains/keys |
| `POST /api/auth/windows` | Local Windows-mode sign-in with empty JSON body | Trusted loopback IIS identity/key; active AD GUID/SID/employee-code SQL mapping required; no automatic registration |
| `POST /api/auth/login` | Username/email, password, optional remember | Account lockout; source-IP throttling; 403 in local Windows mode |
| `GET /api/session` | Safe identity or authenticated:false | SQL expiry/revocation/stamp/account check; local Windows mode also revalidates trusted IIS/AD identity |
| `POST /api/auth/logout` | Revoke session and clear cookie | Idempotent when logged out |
| `POST /api/auth/change-password` | Current/new password | Nonempty, at most 128 characters; revokes sessions; 403 for local Windows accounts/mode |
| `POST /api/admin/login` | Admin-only compatibility alias | Non-admin session revoked |
| `GET /api/admin/session` | Compatibility session alias | authenticated reflects admin role |
| `POST /api/admin/logout` | Compatibility logout alias | SQL revocation |
| `GET /api/admin/users` | Admin safe account list | Local employee identity/department fields and provisioning UI; no pagination |
| `GET /api/admin/employees?query=...` | Local admin read-only active AD employee search | 2–100 characters, at most 20 profiles; distinct from Power Automate recipient lookup |
| `POST /api/admin/users` | Admin account creation | Local AD configuration requires directoryId/roles/department, re-queried AD mapping and no PCN password; old password path only without AD config in password mode |
| `POST /api/admin/users/:uuid/directory` | Local admin links existing account to selected active AD identity | directoryId only; preserves user ID/roles and legacy hash, revokes sessions and blocks linked password login/change in every mode; existing-admin link blocked in password mode |
| `GET /api/admin/directory-users?query=...` | Admin backend directory lookup with distinct private endpoint | query/searchTerm payload; profile fields and safe inline photos; no Firebase runtime |
| `GET /api/admin/notifications/health` | Admin read-only local endpoint validation + SQL queue/worker outcomes | No fetch, flow invocation, queue mutation or email; normal session required |
| `POST /api/admin/notifications/test` | Admin compatibility mail test using recipient/groupId | Explicit admin recipient allowed; invokes mail only when explicitly requested; not called by health UI |
| `GET /api/master-data` | Authenticated active SQL master | Historical-version endpoint pending |
| `GET /api/notification-settings` | Admin routing/configured flags | Local v2: schemaVersion=2, hash version, 16 groups and seven safe legacyGroups; no signed URLs |
| `PUT/PATCH /api/notification-settings` | Admin full versioned recipient save + audit | Local v2 requires schemaVersion=2, fetched version/all 16 groups; missing/duplicate/unknown groups 400, stale version 409; legacyGroups server-owned |
| `GET /api/pcns?status=...` | Owner-scoped supplier/internal list | Array response, no pagination |
| `POST /api/pcns` | Validated create, SQL counter, audit | Server owner/master version; initial draft/submitted |
| `GET /api/pcns/:id` | Authorized hydrated aggregate | Nested payload and rowversion |
| `PUT/PATCH /api/pcns/:id` | Authorized field/status/review update | Expected version, department permissions, signoff prerequisites |
| `DELETE /api/pcns/:id` | Admin soft-delete | Expected version; history retained; ordinary reads hidden |
| `POST /api/pcns/:id/comments` | Authorized append, server actor/role | Expected version; returns aggregate |
| `POST /api/pcns/:id/approvals` | Internal append in permitted state | Expected version; separate from checkbox signoff |
| `GET /api/pcns/:id/workflow` | Authorized risk-derived route | RL0 omits TaPBU |
| `GET /api/pcns/:id/progress` | Authorized derived progress | Current rule definition |
| `GET /api/pcns/:id/audit` | Internal audit read | Suppliers denied |
| `POST /api/pcns/:id/notifications/workflow` | Internal legacy-policy whole-department enqueue, 202 | Uses legacyGroups under schema 2; policy 2 returns handled_on_save without enqueueing again |
| `POST /api/pcns/:id/documents` | Authorized fileName/contentType/base64 upload | Supplier stage restrictions, pendingScan; UI pending |
| `GET /api/pcns/:id/documents/:uuid` | Authorized same-PCN download | Clean scan required |
| `DELETE /api/pcns/:id/documents/:uuid` | Authorized hard deletion | Required version, locked owner/stage check, atomic parent version and audit |

Schema roles: `admin`, `reviewer`, `supplier`, `gsc`, `productionengineering`, `qa`, `tapbu`. Department review permissions are enforced; admin/reviewer can manage all review fields. Supplier ownership is per user, not display name/email domain.

Employee provisioning uses SamAccountName as Empcode and persists AD object GUID/SID for identity matching. Create User assigns explicit PCN roles and department; AD department does not grant signing rights. Existing signing/ownership rules remain unchanged. The staged rollout is complete: `KEMET.COM` / `KEMET` are verified, a separate AD-mapped administrator exists, and PCNTest uses Windows Authentication with the protected PostAuthenticateRequest identity module. The runbook distinguishes real client HTTP checks from isolated browser and workflow tests.

## Notification health and original mail contract

`GET /api/admin/notifications/health` requires a valid admin session that has completed any forced password change. It returns the normal success/data envelope. It validates the server endpoint locally and performs a read-only SQL aggregate; it never fetches the flow, sends test mail or changes queued jobs. SQL/health failure returns a generic 503.

| Response field | Values / meaning |
|---|---|
| configuration.status | configured, not_configured, invalid; local HTTPS/host-allowlist validation only |
| worker.lastCheckedAt | UTC ISO timestamp or null; last check by this process's worker, reset on restart |
| worker.lastOutcome | idle, accepted, uncertain, error or null; latest local worker outcome |
| queue.pending / sending | SQL job counts, not recipient counts |
| queue.accepted | SQL legacy Status=sent count, exposed as accepted because HTTP success is not email delivery |
| queue.uncertain | Ambiguous outcomes needing operator review |
| queue.latestAcceptedAt | Latest accepted job timestamp or null |
| deliveryVerified | Always false; no delivery receipt/probe is performed |

The UI is simplified to one compact **Mail service** row with a badge and **Check status** button. Recipient mapping, directory-assisted selection and routing saves remain editable. Queue counts, worker/timestamp details and a delivery paragraph are not displayed in this row; the backend health response above is unchanged. The button does not call the compatibility `POST /api/admin/notifications/test` endpoint or send mail.

| Compact UI result | Meaning |
|---|---|
| Ready | Configuration is valid, with no known worker error/uncertain outcome or uncertain queued jobs; not proof of delivered email |
| Not configured | Mail endpoint is absent |
| Needs attention | Invalid configuration, worker error/uncertain outcome or uncertain queue |
| Unavailable | Health fetch failed or the response is malformed |

Compact-row validation passed 16/16 isolated browser checks and 14/14 focused frontend tests; a reviewer independently passed 14 notification-health API tests. Code, JavaScript and accessibility reviews approved with no findings. Local coverage passed 155/155 with 95.03% lines, 88.27% branches and 94.70% functions; release CI separately passed 155 tests/16 browser checks, and deployed HTML contains the compact row. A configured/Ready state does not probe remote reachability or delivery. Actual authenticated use of the deployed health row and email delivery remain unverified.

The signed endpoint remains fixed in private server `POWER_AUTOMATE_MAIL_URL` configuration with an exact allowlisted hostname. The Windows service reads it through its protected external `PCN_ENV_FILE`. Neither health/settings responses nor UI edits expose or change the URL. Committed templates contain empty placeholders; GitHub Actions and public releases never receive it.

Workflow mail preserves the pre-migration JSON keys exactly: `to`, `subject`, `message`, `senderName`. The restored escaped HTML message contains the Supplier PCN Workflow card, PCN/supplier/material/risk details, Current Status, Next To Check and Open PCN link. The server resolves recipients, groups and canonical portal URL; client values cannot replace them. Empty recipient groups remain empty with no old hardcoded fallback. The queue's accepted outcome denotes upstream HTTP acceptance, not delivery.

- [x] Complete develop branch local tests/review for payload, HTML escaping, health auth and read-only behavior: 148/148 tests, 95.00% line / 87.54% branch / 94.67% function coverage; 14 isolated browser checks with no SQL/flow calls. Backend, JavaScript, code and security reviews approved.
- [x] Complete compact Mail service row local tests/review: 16 browser checks, 14 focused frontend tests and independent 14 health API tests; code/JavaScript/accessibility approved. Health API remains unchanged.
- [x] Main commit 359e1c43e39b30ec8ef1ebfbed30daa0bd54d939 passed CI and deployed as signed pcn-test-6-1.
- [x] Verify deployed compact HTML, exact service identity and HTTPS SQL readiness without sending test mail.
- [ ] Verify the health row in an actual authenticated pilot browser session; isolated browser checks are separate.
- [ ] Record any future explicit send/delivery verification separately; health always reports deliveryVerified=false.

Private host mail/directory configuration was updated atomically under the deployment mutex with zero pending/sending jobs, original ACLs and protected backup retained. The directory update preserved existing mail/SQL values and made no SQL writes, service restart or flow invocation. The subsequent release restart loaded that configuration; mail configuration validates locally and a host backend directory lookup returned a matching inline-photo profile. No test email or delivery check was performed.

## Department/action routing-v2 — local implementation

The editor has five department cards with Approved/Checked/Prepared lists plus supplierNotification. QA/TET review/final judgment reuse lists with distinct messages. The first Save Mail persists schema 2; only newly created PCNs select policy 2. Existing records retain policy 1 when policy is absent. GET returns a 64-character settings hash as version; full PUT/PATCH sends that version, not an expectedVersion JSON field. SQL locks/rechecks it before settings/profile/audit writes. The UI keeps drafts on 409, confirms reload and supports explicit legacy-contact copying without editing legacyGroups.

Policy-2 PCN saves atomically persist server-owned activation state and an eligible job with parent/audit. A transient notification response reports queued=true with jobId/status, queued=false with a blocked reason, or no_transition; app.js uses it instead of a second POST. Unchanged saves and settings edits do not enqueue. Blocked handoffs are not released by later recipient/config changes. Supplier action/signoff reset cancels only pending jobs; status-only closure preserves the queued final supplier notice. Explicit blocked retry and legacy opt-in APIs are not implemented.

Local verification: 184/184 tests, 95.33% lines / 88.87% branches / 95.32% functions, and 26/26 browser checks. Final code, JavaScript, security and accessibility reviews approved with no findings. The local served admin.js returned 200 with separated department/step/versioned-save UI. These checks performed no live SQL/mail/test send or deployment.

## Directory lookup compatibility

`GET /api/admin/directory-users?query=...` requires an admin session that has completed any forced password change. A trimmed search is 2–100 characters. The backend calls the distinct private `POWER_AUTOMATE_DIRECTORY_URL` using HTTPS with an exact allowlisted hostname; the directory endpoint must not be replaced by the mail endpoint. The original configuration was recovered through a one-time read-only inspection of legacy Firestore settings. Runtime lookup calls Power Automate directly and does not use Firebase.

| Contract | Behavior |
|---|---|
| Flow request JSON | Identical trimmed text in `query` and `searchTerm` |
| Accepted flow responses | Direct array, or array in users, value or results |
| API response | Normal success/data envelope containing users; at most 50 entries; malformed profiles skipped |
| Profile fields | id/displayName/email, plus jobTitle and department limited to 120 characters each |
| Photos | Inline PNG/JPEG/GIF/WebP data URIs only, total URI length at most 100 KiB; remote URLs and unsupported images omitted |
| Request bounds | Existing 10-second timeout, 256 KiB response cap, rejected redirects and local HTTPS/host checks |

The ignored local `.env` enables only directory lookup; local mail remains disabled by this change. Private configuration is external to releases. Actual signed endpoint URLs, hosts/signatures and profile identifiers are not documented or published.

- [x] Earlier directory unit/API suite: 155/155; focused integration 14/14, 100% lines / 93.81% branches / 94.44% functions.
- [x] Original directory flow lookup returned one matching user with name/job title/department/photo; identifying data remains private.
- [x] Local SQL readiness returned 200 after watch reload.
- [x] Enhanced directory browser checks: 16/16 passed; dropdown rendering of name/email/title/department/photo was inspected. Earlier mail-health browser results are separate.
- [x] Final code/security reviews approved with no critical/high findings.
- [x] Release CI 155 tests/16 browser checks passed; pcn-test-6-1 deployed with verified process identity and HTTPS SQL readiness. Host backend lookup returned one matching profile with inline photo; private configuration stays external to releases.
- [ ] Verify actual authenticated directory UI on a client; isolated browser rendering tests do not establish that result.

The earlier 148-test mail-health and 155-test directory coverage are historical. Current local routing verification is 184/184 with 95.33% lines, 88.87% branches and 95.32% functions; deployed pcn-test-6-1 evidence remains separate.

## Implemented browser/integration changes

- [x] app.js/admin.js use API persistence and server identity.
- [x] session-client.js handles cookie/CSRF requests and expired sessions.
- [x] Login and forced password change pages replace shared admin-password handling.
- [x] Active form/admin pages no longer load Firebase adapters.
- [x] Browser actors/roles/recipients/URLs cannot override workflow authority.
- [x] Integration secrets stay server-side; configured flags go to the browser.
- [x] Integration requests have HTTPS/exact-host checks, no embedded credentials, bounded response/timeout and rejected redirects.
- [x] PCN writes carry version tokens; stale updates require refresh.
- [x] Empty mail mappings have no default recipient/browser fallback.
- [x] Static serving uses an explicit asset allowlist.

## Remaining APIs and behavior

- [ ] Forgot/reset/activation/invitation endpoints and one-time token consumption. AccountTokens exists but recovery is not shipped.
- [ ] Admin profile/disable/role/membership routes and UI; last-admin protection and audited changes.
- [ ] Company membership/reviewer assignment and reviewed legacy ownership.
- [ ] Master-version endpoint and historical rendering/validation against pinned definition.
- [ ] Bounded paginated SQL lists and coordinated frontend pagination.
- [ ] General create/comment/approval idempotency; mail event dedup covers only notification jobs.
- [ ] Immutable signoff events, legacy-policy opt-in, explicit blocked retry, cancellation beyond pending handoffs and mail status/retry APIs. Local policy-2 save/outbox coupling is implemented.
- [ ] Trusted malware scan, attachment UI, audited retention/deletion and requirement/file association.
- [ ] Distributed throttling and deployment request limits. Current API throttles source IPs to 600 requests / 60 mutations per minute, with bounded tracking; attachment quotas also apply.

## Release evidence checklist

- [x] Record SQL2014 / compatibility120; apply migration; confirm bootstrap and empty routing.
- [x] Live create/update/reload/delete, Unicode/nested round trips, auth/session revocation and rollback.
- [ ] Live concurrent allocation and backup/restore drill.
- [x] Browser login → forced change → re-login → create/save/reload and admin routing (isolated test adapters).
- [x] Direct HTTP owner/department denials, CSRF/stale-version checks (test adapters).
- [ ] Restart/revocation, database outage and integration timeout behavior.
- [ ] Reconcile a reviewed real export: counts, counters, unknown fields, owners. Never auto-import demo data.
- [ ] Configure HTTPS, credentials/grants, backups/restore and ambiguous-mail handling.

Fake repositories/SQL adapters establish contracts, not live persistence or deployed-browser success. Future acceptance criteria remain in [the migration plan](sql-server-migration.md).
