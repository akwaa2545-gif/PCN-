# SQL Server API inventory and checklist

Updated: 2026-10-06. Sources: `src/apiRoutes.js`, `src/httpServer.js`, auth, workflow and integration modules. Implemented code, live release checks and future features are distinguished below. The restored mail HTML and notification-health API/UI on `develop` passed local tests and specialist reviews but are not yet merged/deployed or verified in CI/live acceptance.

Setup status: SQL2014-compatible migration applied on `svr120a / Scn_DB`; master-data version 1 and forced-change `itadmin` account created. Seven routing groups are empty. Real SQL smoke checks and isolated browser E2E passed. The earlier SQL pilot/pipeline deployment is recorded in [the Windows runbook](windows-test-deployment.md); those checks do not verify the current mail-health changes. Existing Firebase data import remains pending.

## Shared contract

- JSON success: `{success:true,data}`; errors: `{success:false,error,details?,code?,requestId}`. Download returns file bytes.
- Sessions expose safe user/roles, CSRF token and expiry, never password hashes or session-token hashes.
- Except health/readiness/login/session/logout, routes require a SQL session. Force-change accounts can access only password change.
- Mutations require the configured origin and `X-CSRF-Token`. Login requires the origin; logout checks CSRF when authenticated.
- PCN update/delete/comment/approval requires a fetched 16-character hex `version`; stale versions return 409. PUT and PATCH both merge PCN updates.
- Suppliers are scoped by `ownerUserId`; internal roles currently see broader records. Company membership/assignment scope is pending. Actors/roles are server-derived.
- Parent/children/review/audit changes are transactional. Workflow-mail enqueue is separate from PCN save.
- JSON limit is 1 MB; file upload has a separate 15 MB JSON cap and 10 MiB decoded limit.
- Errors include 400 invalid input, 401 no session, 403 denied, 404 unavailable record, 409 conflict, 413 excessive body, 423 unscanned download, 429 login throttling, 503 readiness/configuration failure. Unexpected backend failures return generic 500.

## Implemented endpoints

PCN API identifiers are canonical `PCN-YYYY-NNNN`; browser alias normalization is separate.

| Method and path | Behavior / permission | Limitation or check |
|---|---|---|
| `GET /api/health` | Public process liveness | Does not test SQL |
| `GET /api/ready` | Public schema/table/master readiness | SQL unavailable returns 503 without SQL details |
| `POST /api/auth/login` | Username/email, password, optional remember | Account lockout; in-process source-IP throttling |
| `GET /api/session` | Safe identity or authenticated:false | SQL expiry/revocation/stamp/account check |
| `POST /api/auth/logout` | Revoke session and clear cookie | Idempotent when logged out |
| `POST /api/auth/change-password` | Current/new password | Nonempty, at most 128 characters; revokes sessions; re-login |
| `POST /api/admin/login` | Admin-only compatibility alias | Non-admin session revoked |
| `GET /api/admin/session` | Compatibility session alias | authenticated reflects admin role |
| `POST /api/admin/logout` | Compatibility logout alias | SQL revocation |
| `GET /api/admin/users` | Admin safe account list | No pagination/UI |
| `POST /api/admin/users` | Admin creates user/roles/password | Normal password policy, forced change, optional email; no invitation |
| `GET /api/admin/directory-users?query=...` | Admin directory lookup | Server HTTPS host allowlist |
| `GET /api/admin/notifications/health` | Admin read-only local endpoint validation + SQL queue/worker outcomes | Develop change; no fetch, flow invocation, queue mutation or email; normal session required |
| `POST /api/admin/notifications/test` | Admin compatibility mail test using recipient/groupId | Explicit admin recipient allowed; invokes mail only when explicitly requested; not called by health UI |
| `GET /api/master-data` | Authenticated active SQL master | Historical-version endpoint pending |
| `GET /api/notification-settings` | Admin routing/configured flags | No signed URLs; fixed server endpoint is not a UI setting |
| `PUT/PATCH /api/notification-settings` | Admin full normalized recipient/settings save + audit | Recipient mappings remain editable; omitted groups become empty; send complete settings; signed URL supplied by server only |
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
| `POST /api/pcns/:id/notifications/workflow` | Internal next-group enqueue, 202 | Event dedup; empty routing returns queued:false; server recipient/link |
| `POST /api/pcns/:id/documents` | Authorized fileName/contentType/base64 upload | Supplier stage restrictions, pendingScan; UI pending |
| `GET /api/pcns/:id/documents/:uuid` | Authorized same-PCN download | Clean scan required |
| `DELETE /api/pcns/:id/documents/:uuid` | Authorized hard deletion | Required version, locked owner/stage check, atomic parent version and audit |

Schema roles: `admin`, `reviewer`, `supplier`, `gsc`, `productionengineering`, `qa`, `tapbu`. Department review permissions are enforced; admin/reviewer can manage all review fields. Supplier ownership is per user, not display name/email domain.

## Notification health and original mail contract — develop

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

The UI's **Check Notification Health** action replaces the test-email button while preserving recipient mapping, directory-assisted recipient selection and routing saves. No health action calls the compatibility `POST /api/admin/notifications/test` endpoint. A configured status does not establish DNS/network reachability, a successful remote flow, valid flow credentials or delivered email.

The signed endpoint remains fixed in private server `POWER_AUTOMATE_MAIL_URL` configuration with an exact allowlisted hostname. The Windows service reads it through its protected external `PCN_ENV_FILE`. Neither health/settings responses nor UI edits expose or change the URL. Committed templates contain empty placeholders; GitHub Actions and public releases never receive it.

Workflow mail preserves the pre-migration JSON keys exactly: `to`, `subject`, `message`, `senderName`. The restored escaped HTML message contains the Supplier PCN Workflow card, PCN/supplier/material/risk details, Current Status, Next To Check and Open PCN link. The server resolves recipients, groups and canonical portal URL; client values cannot replace them. Empty recipient groups remain empty with no old hardcoded fallback. The queue's accepted outcome denotes upstream HTTP acceptance, not delivery.

- [x] Complete develop branch local tests/review for payload, HTML escaping, health auth and read-only behavior: 148/148 tests, 95.00% line / 87.54% branch / 94.67% function coverage; 14 isolated browser checks with no SQL/flow calls. Backend, JavaScript, code and security reviews approved.
- [ ] Run CI for these changes before merge/deployment; previous pilot CI is separate evidence.
- [ ] Verify the deployed health UI and local/SQL status behavior without invoking the flow or sending test mail.
- [ ] Record any future explicit send/delivery verification separately; health always reports deliveryVerified=false.

Private host configuration is staged for the next service start. Before its update, a read-only SQL check found zero pending/sending jobs. The environment file was replaced atomically under the deployment mutex, with its existing ACL retained and a protected backup. No database writes, service restart or flow invocation occurred. This records configuration staging, not live acceptance of the new endpoint/UI.

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
- [ ] Immutable signoff events, atomic save/outbox coupling, deletion cancellation, mail status/retry APIs.
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
