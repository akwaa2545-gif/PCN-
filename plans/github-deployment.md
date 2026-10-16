# GitHub deployment to the internal Windows test host

Updated: 2026-10-16. Signed `pcn-test-21-1` is installed on the existing HTTP :8443 origin. All 28 CI steps, exact-release identity, 31 public asset checks and SQL readiness passed. Migrations 001–007 were already applied with matching checksums. Five live browser groups passed. A repeat consumer returned `already_current` with Node PID 8400 unchanged, and final independent checks confirmed the SYSTEM task enabled / Ready / last result 0. Earlier runtime evidence is preserved below.

The `PCN test deploy` workflow builds the public `akwaa2545-gif/PCN-` repository on a GitHub-hosted Windows runner. The internal PCN host checks GitHub for signed releases through outbound HTTPS every ten minutes. The host does not accept inbound GitHub SSH connections and does not run a self-hosted Actions runner.

```text
Push main -> Windows Actions tests -> production runtime ZIP -> signed prerelease
                                                                 |
                           internal scheduled task <- outbound HTTPS poll
                                      |
                   signature/hash/path checks -> service restart -> SQL readiness
                                      |
                             failed check -> previous release
```

## Build and signing contract

[pcn-test-deploy.yml](../.github/workflows/pcn-test-deploy.yml) runs on runtime-changing pushes to `main` and manual dispatch on `main`; README/plans-only changes are ignored. Pull requests and other branches do not publish deployment releases. Actions dependencies are pinned to commit hashes. The job uses Node 26.10.0 to match the pilot host, installs locked dependencies, checks for high/critical dependency advisories, runs unit/API tests and isolated browser tests, then removes development dependencies.

The build runs [package-release.js](../scripts/package-release.js) with the private Ed25519 key from GitHub Actions secret `PCN_RELEASE_SIGNING_KEY`. This secret belongs to the repository's deployment workflow; it must never be checked into source, included in an artifact or printed in logs. The server receives only the corresponding public key. Repository administrators and anyone able to change `main` or its workflow are deployment authorities; protect `main` and restrict those permissions accordingly.

Each prerelease uses a unique tag `pcn-test-<runNumber>-<runAttempt>` and has exactly these assets:

| Asset | Contents |
| --- | --- |
| `pcn.zip` | Windows runtime source, public static assets and production `node_modules` |
| `manifest.json` | Schema 1, fixed repository, run number/attempt, 40-character commit, matching release ID, archive name and SHA-256 |
| `manifest.sig` | Base64 Ed25519 signature over the exact manifest bytes |

The allowlist excludes `.env`, credentials, certificates, private keys, repository metadata, tests, SQL migration scripts and developer exports. The public ZIP is downloadable by anyone, so only public application code/assets and dependencies may enter it. The app's SQL credentials remain in its existing protected external configuration.

## Server installation

The established IIS site, certificate, service and configuration are described in [windows-test-deployment.md](windows-test-deployment.md). This pipeline changes the running application release only. It does not create SQL tables, import data, bootstrap users, change IIS/firewall settings, distribute certificates or send integration mail.

Automatic updates, introduced in runtime 15 and retained in runtime 21, reuse the existing `session-client.js` asset and authorized GET routes. Visible pages poll every five seconds; unchanged data is not redrawn, filters/focus/scroll are retained, and hidden pages pause. Busy actions, open dialogs and routing drafts defer refresh; failures back off to thirty seconds. Clean saved PCNs refresh automatically, while unsaved edits keep their saved-version baseline and show **Reload latest** with discard confirmation. This needs no protected-consumer or IIS update and makes no SQL writes or mail calls. Runtime 15's live acceptance remains historical evidence below.

Install these independently reviewed files under `C:\SupplierPCN\deployment`, accessible for modification only by SYSTEM and local Administrators:

| Server file | Source |
| --- | --- |
| `deploy-pcn-release.ps1` | [scripts/deploy-pcn-release.ps1](../scripts/deploy-pcn-release.ps1) |
| `verify-release.js` | [scripts/verify-release.js](../scripts/verify-release.js) |
| `release-signing-public.pem` | Public key corresponding to the Actions signing secret |

The verifier and public key are pinned local trust anchors. A downloaded release cannot replace either file or the scheduled-task script. Updating these files or rotating the signing key requires a separate administrator operation. Preserve the public-key fingerprint in the protected deployment installation record, and compare it when changing the trust anchor.

Register scheduled task `SupplierPCNTestDeployment` to run as SYSTEM, with highest privileges, every ten minutes and at startup, using the fixed action:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\SupplierPCN\deployment\deploy-pcn-release.ps1
```

Set the task to ignore overlapping instances. The script also uses the global `SupplierPCNTestDeployment` mutex. Do not provide repository URLs or executable arguments from a release or task parameters. Outbound HTTPS to GitHub API/release endpoints must be available; SQL server connectivity and the existing protected service configuration must already work.

Before enabling automatic cutover, an administrator can validate the latest signed artifact without switching the service:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\SupplierPCN\deployment\deploy-pcn-release.ps1 -ValidateOnly
```

This downloads and checks the artifact in private staging, then removes staging. It does not change the service XML or deployment version records. The deployment/staging directory permissions are enforced during validation.

## Verification and cutover

The poller makes one unauthenticated release-list API request per run: six requests per hour at the normal interval, below GitHub's 60-request unauthenticated hourly limit. Other software sharing the same public outbound IP may consume that quota. A rate-limit or network failure leaves the running release in place. [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

Only matching published prereleases are candidates. The latest matching version must be newer than both the last successful deployment and the last attempted cutover. The server authenticates manifest bytes with the pinned Ed25519 key before downloading the ZIP, then independently verifies the ZIP SHA-256 before opening it. URLs and HTTPS redirects are restricted to expected GitHub endpoints; TLS certificate verification remains enabled.

Before extraction, every entry is checked for traversal, Windows device names, alternate data streams, duplicate names, conflicting file/directory paths, symlinks and other special file types. Only the runtime allowlist and production dependency tree are allowed. Limits are 200 MiB downloaded archive, 500 MiB expanded data, 100 MiB per entry and 40,000 entries. Extraction also enforces actual stream lengths.

Each validated release receives its own `C:\SupplierPCN\releases\pcn-test-<number>-<attempt>` directory. SYSTEM and local Administrators have full access; the unique `NT SERVICE\SupplierPCNTest` SID has read/execute access. Child ACLs are reset after the move and checked on entry-point/source/dependency paths. The NetworkService application cannot modify a release or the deployment controls; the shared NetworkService account has no SQL/environment-file read grant.

Immediately before switching, the server atomically records `last-attempt.json`. It stops only `SupplierPCNTest`, checks that its old loopback listener is gone, and changes only `arguments` and `workingdirectory` in the WinSW 2 service XML. The external SQL configuration path, service account, logs, executable and other settings are preserved. No package installation or SQL migration command runs on the server.

After restart, `/api/ready` must return `success: true` with `data.status: ready` within sixty seconds. This checks SQL availability. The deployment also verifies that the listener is exclusively `127.0.0.1:3000`, belongs to Node launched by the intended WinSW service, uses the exact new `server.js` path and runs as exact `NT AUTHORITY\NetworkService`. Only then does the server atomically update `last-deployed.json`. Readiness alone does not replace real employee-code source lookup/login acceptance.

During cutover there is a brief interruption because the pilot runs one backend instance. A failed readiness or identity check restores the exact previous service XML, restarts the previous release and checks its readiness/identity. A failed rollback requires operator intervention. The last successful deployment record is not advanced after a failed cutover.

## Operation and recovery

Inspect scheduled-task status and the protected `C:\SupplierPCN\deployment\deployment.log`. Events contain timestamps, fixed event names and release IDs, never configuration or SQL credentials. `deployed` indicates completed cutover; `rollback_ready` indicates the previous release recovered; `rollback_failed_operator_required` requires immediate administrator inspection. `previous_attempt_requires_new_release` means the same failed version is intentionally not attempted again.

Fix a failed application release and push a new commit, or rerun its GitHub workflow to publish a higher run attempt. Preserve both version records: deleting them removes replay protection and deployment history. Rollback restores the service XML captured before cutover. Keep failed release folders for investigation; the poller will not overwrite an existing release directory. Manual service rollback does not erase the version high-water records.

For a signing-key rotation, disable the task, update the Actions secret and pinned public key through the administrator channel, verify their pairing, validate a newly signed higher version, then re-enable the task. Never accept a public key supplied inside a release. To pause automatic deployment without stopping the application, disable `SupplierPCNTestDeployment`; existing IIS and service operation continue.

The workflow is scoped to the established test service and existing `Scn_DB`. Application saves and password changes still affect that database. Deployment checks do not reset passwords or create test PCN records there.

## Employee-code cutover gate

The replacement defaults to `AUTH_MODE=employee-code`; password mode is explicit maintenance only. It reads `[KEY_Code_DB].[dbo].[tblEmployee]` on the same configured SQL server, with no source writes, synchronization or bulk import. Selected employees still require active PCN accounts and explicit roles/departments. Migration 003 retires old AD mappings and revokes their sessions/tokens; a verified, explicit source-code link preserves the intended PCN user ID, roles and ownership.

Disable the polling task before selecting a replacement runtime. Separately preserve the database/configuration before-state, verify the administrator's intended source code, apply migration 003 and update **PCNTest only** to Anonymous Authentication enabled / Windows Authentication disabled. Archive/remove the retired Windows identity module/key setup and keep HTTPS, SQL secret isolation, loopback binding and ordinary server-owned client-IP rewrite. The replacement no longer carries the AD helper, Windows login route or identity-header proof.

Independently install the reviewed updated deployment consumer if its runtime allowlist changed; repository edits do not replace the protected host consumer. Validate the signed replacement archive, perform scoped cutover, verify real source-backed employee-code login/session/authorization/logout and exact service/listener identity, then record the actual release/results and resume polling. This rollout completed the gate with a separately created `2205529` Administrator / IT account and the prior three accounts preserved; it did not relink the former AD administrator. Restoring the old Windows release after migration 003 does not automatically restore retired mappings; use the [reviewed recovery boundary](employee-code-authentication.md#recovery-and-further-checks).

## Acceptance evidence

### Current runtime — pcn-test-21-1; motion and compact laptop layouts

[Actions 38845184965](https://github.com/akwaa2545-gif/PCN-/actions/runs/38845184965) completed all 28 steps successfully and published signed [pcn-test-21-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-21-1) from commit `1d6f77f9e27307033c09a3f3d5c96568cd06c1bc` at `2026-10-16T03:29:24Z`. The 15,877,833-byte ZIP has SHA-256 `abac6c298b9c259a6e352d1c6d687605da71222f8eee9aafdf4067c1ebffdb24`. CI passed its unit/API, high/critical audit and existing browser gates, plus the normal motion, native-select, compatibility, populated Users and compact Records suites. Local verification passed 989 tests with 88.23% line / 91.09% branch / 94.61% function coverage; detailed fixture/LAN evidence is in [the motion and layout record](ui-motion.md).

The release adds 160 ms native-dialog motion, 240 ms Create/profile and supported native-select fades, immediate reduced-motion behavior and guarded presentation cleanup. Populated Users retains all nine columns and 14 px text with compact sticky actions and contained scrolling. Records at normal browser zoom retains a 280 px sidebar from 1200 px upward, a compact header, five filters per row and 13/14 px table/Supplier-Material text; narrow/mobile fallbacks and official print remain separate. The development-only localhost origin correction does not relax production's exact-origin contract.

Validate-only completed at observed host time `2026-10-16T03:36:45.9208784Z`, retaining runtime 18, Node PID 6008 and the disabled task. Activation completed at `2026-10-16T03:38:59.9990547Z`. Independent checks at `2026-10-16T03:39:33.1709468Z` confirmed exact-release Node PID 8400, WinSW parent PID 18132, `NT AUTHORITY\NETWORK SERVICE` ownership, the sole `127.0.0.1:3000` listener, public SQL readiness and the unchanged `http://172.30.77.137:8443` origin. Unrelated Default Web Site HTTP :80 returned 200. All 31 checked public assets matched the source; three private paths returned 404. The ignored asset report is `test-results/deploy-ui-assets.json`.

The private environment hash/ACL, proxy, protected consumer, verifier and pinned key were unchanged. Read-only SQL checks retained the seven matching migration checksums and verified the existing active Developer account. Deployment ran no DDL, account import, bootstrap or operational mail tests. Repeat-consumer/task resumption and final independent checks passed, as recorded below.

Guarded live browser acceptance passed five groups and eight measured fade entries/exits, with 14 captures, at workstation UTC `2026-10-16T03:34:21.552Z`–`2026-10-16T03:35:12.964Z`. The host clock is approximately five minutes ahead and its timestamps above are recorded separately. At 1536, 1366 and 1280 px, computed zoom remained `1`, the header was 64 px, sidebar 280 px and five 34 px filters occupied one row; table scrolling stayed contained and the sticky sidebar cleared the header. Create/profile and native role/department picker fades, Escape/focus/value retention, the outer access dialog, 390 px popup/options fit and mobile Create choices passed. Only existing-account login/logout writes were allowed and the session was signed out. There were no business writes, external calls, directory lookups, page errors or unexpected failed responses. Notification-health/settings reads were deliberately fulfilled locally with 503 to avoid integrations; their expected guard toast is not a production outage. The ignored report is `test-results/live-motion-laptop-acceptance.json`.

A repeat protected-consumer check returned `already_current` for runtime 21 / commit `1d6f77f9e27307033c09a3f3d5c96568cd06c1bc`, retaining Node PID 8400. Independent final checks at observed host UTC `2026-10-16T03:43:41.6397963Z` confirmed the exact release/source, Node PID 8400 / WinSW parent PID 18132, NetworkService ownership, the sole loopback listener, public SQL readiness, unchanged HTTP :8443 binding and unrelated Default Web Site HTTP :80 returning 200. Environment hash/ACL, proxy and deployment trust hashes were unchanged. The SYSTEM task is enabled / Ready / last result 0. Ignored evidence is in `test-results/deploy-ui-resumed.log` and `test-results/deploy-ui-identity-final.json`.

### Historical runtime — pcn-test-18-1; application and Mail Routing improvements

[Actions 38714287181](https://github.com/akwaa2545-gif/PCN-/actions/runs/38714287181) completed all 23 steps successfully and published signed [pcn-test-18-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-18-1) from commit `1edcec3bb13dce5df6e7d6cd4c079334a5f8aec9` at `2026-10-15T09:42:24Z`. ZIP SHA-256: `108bb30d4afbc217a4972d6c1a4c90539e1680678b525f65104704b8e508c1cc`. The final local suite passed 971/971 tests with 88.34% line / 91.04% branch / 94.69% function coverage; the audit found no high/critical advisories. CI includes the guided Create, Developer Tools, user-presence and Mail Routing browser gates alongside the existing workflow, automatic-update, timeline, signing-order, Records and Developer-access checks.

The release includes the dedicated Create page and marked testing documents, Developer-only workflow/transaction tools and protected Developer assignments, Prepared → Checked → Approved signing and next-action routing, department-scoped Administrator update mail, the Records dashboard with gold Open PCN links and icon actions, department signing summaries, authenticated Online/Offline presence and the supplied Segoe UI Semibold table font. Mail Routing has one **Assign user** action per department header, an explicit signing-role/verified-directory popup and expandable department lists. These popup edits remain unsaved routing changes until **Save Mail**; they do not grant signing access or send mail.

Before validation, the protected host consumer was independently updated only for its runtime-file allowlist, with a protected backup and ACLs retained. Consumer SHA-256: `36D8433E617345CE405788A9DB6722D7C5B4BA759FA4BA87E9BA66C8CF5A47B6`. The verifier and pinned public key were unchanged; public-key SHA-256 remains `04D893A9C5021114C816C9DA5BDD5D7A80EA6E061C6573CACB9196CC38EA3306`. A scoped private configuration change added the Developer assignment hash with backup and ACLs preserved; other configuration was retained. The Developer assignment credential remains private. Read-only checks of the host's configured SQL target confirmed migrations 001–007 were already applied and every checksum matched source. No DDL, bootstrap, account/role changes, PCN/recipient writes or test mail were performed by these checks.

Validate-only succeeded at observed host time `2026-10-15T09:49:16Z`, preserving runtime 17 and Node PID 9280. Activation completed at observed host time `2026-10-15T09:50:39.4118586Z`. Independent checks at `2026-10-15T09:52:14.7555897Z` confirmed exact-release Node PID 6008 beneath WinSW parent PID 12092, `NT AUTHORITY\NETWORK SERVICE` ownership and the exclusive `127.0.0.1:3000` listener. Public readiness returned `ready`; unrelated HTTP :80 returned 200. All 21 checked public assets matched the release, including the exact font bytes and `font/ttf` MIME; `.env`, SQL configuration source and the deployment script returned 404. The existing public origin `http://172.30.77.137:8443` and loopback backend `127.0.0.1:3000` are retained.

Fresh guarded live browser acceptance passed five groups and exited successfully at workstation UTC `2026-10-16T01:27:44.270Z`; the host clock is recorded separately. It covered the gold Open PCN link, department timeline, Users presence and Developer menu/badges, all five Mail Routing department-header assignment controls with role selection, cancel and collapse at desktop and 390-pixel widths, and the four Create choices. The real table font loaded at weight 600, with Supplier/Material at 16 px and Open PCN at 14 px. Only existing-account login/logout writes were allowed and the session was signed out. No business changes, directory calls, operational mail, external writes, page errors or failed responses occurred. The successful fresh run followed an interrupted run that performed no authenticated API reads or authentication writes; the interrupted run is not acceptance evidence. The ignored report is `test-results/live-professional-ui-acceptance.json`.

Fresh host checks at `2026-10-16T01:31:55.4535925Z` retained release 18 / commit `1edcec3bb13dce5df6e7d6cd4c079334a5f8aec9`, exact-release Node PID 6008 and WinSW parent PID 12092. A repeat protected-consumer invocation returned `already_current` at `2026-10-16T01:33:48.0160928Z`; the SYSTEM task rerun also returned `already_current` at `2026-10-16T01:33:50.3911593Z`. Independent final checks at `2026-10-16T01:33:53.0160922Z` confirmed the task enabled / Ready / last result 0 and Node PID 6008 unchanged. No PCN save, signing, recipient change, live attachment scan or notification delivery was exercised by acceptance; scanner/quarantine restrictions remain as documented.

### Historical runtime — pcn-test-17-1; Portal timeline

Historical runtime 17: Actions **View** uses the existing authorized history GET API. Each horizontal point shows recorded time, person and a department/signing action such as **GSC/TET — Checked** or **GSC/TET — Approved**; other events show their recorded workflow status, creation or baseline. Cleared signatures and unavailable earlier history are explicit. Selection reveals before/after form and signing changes, omitting internal storage metadata. Scrolling stays within the mobile popup and Portal polling pauses while the dialog is open. The pipeline runs `npm run test:timeline` against isolated fixtures. No new database migration, public asset or protected-consumer/IIS change is needed.

That runtime's source passed 645 unit/API tests with 91.68% line / 90.87% branch / 93.83% function coverage, and six isolated timeline browser journeys covering 13 genuine events. Viewing made no live business changes or external integration calls.

[Actions 38526805589](https://github.com/akwaa2545-gif/PCN-/actions/runs/38526805589) passed 645 unit/API tests, the dependency audit, the existing isolated workflow browser suite, six automatic-update groups and six timeline groups. Signed [pcn-test-17-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-17-1), commit `6f3b7397139388b3d02a746fdd56cd2ae8349636`, was published at `2026-10-14T07:15:20Z` and installed at observed host time `2026-10-14T07:41:08.6651173Z`. ZIP SHA-256: `3322a8d92bbd480b915007e6cd00394d34bbd021c7ef8b65c93e58ef484a1cda` (15,562,084 bytes).

Validate-only at observed host time `2026-10-14T07:39:11Z` preserved runtime 15 and Node PID 3400. Activation confirmed exact-release Node PID 9280, NetworkService / WinSW identity, sole `127.0.0.1:3000` listener and public HTTP :8443 SQL readiness. Private configuration and proxy hashes/ACLs, HTTP binding/firewall, protected consumer, pinned key and retained recovery certificate were unchanged. Public `admin.js`, `admin.html` and `admin.css` returned 200 and matched the deployed commit after CRLF-to-LF normalization.

Live acceptance passed five groups and fifteen API GETs (all 200) at workstation UTC `2026-10-14T07:35:57.880Z`–`2026-10-14T07:36:19.549Z`; host timestamps are observed separately because its clock is about five minutes ahead. Existing `PCN-2026-0001` showed five genuine events: baseline, GSC/TET Approved, Submitted, GSC/TET Checked and GSC/TET Prepared, with recorded people. Desktop and 390-pixel mobile selection, contained scrolling, Escape/Close and restored View focus passed. Only login/logout POSTs were permitted; no PCN writes, mail, directory/external attempts, page errors or failed responses occurred. One automatic notification-health GET was blocked locally; profile reads were configured to be locally stubbed but none occurred. The ignored report is `test-results/timeline-live-acceptance.json`.

At observed host time `2026-10-14T07:43:27.4776726Z`, a repeat consumer returned `already_current` for runtime 17 with Node PID 9280 unchanged, and the task was resumed Ready. Independent final checks at `2026-10-14T07:44:15.6339410Z` confirmed release 17 / commit `6f3b7397139388b3d02a746fdd56cd2ae8349636`, service Running, sole `127.0.0.1:3000` listener owned by PID 9280, sole PCNTest HTTP `172.30.77.137:8443:` binding, access SSL flags 0 with no SSL mapping, SQL readiness, unrelated Default Web Site HTTP :80 returning 200, and the SYSTEM task enabled / Ready / last result 0.

### Historical runtime — pcn-test-15-1; automatic updates

[Actions 38224241715](https://github.com/akwaa2545-gif/PCN-/actions/runs/38224241715) passed 635 unit/API tests, the dependency audit, existing isolated browser checks and six automatic-update browser groups. Signed [pcn-test-15-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-15-1), commit `73009ce7272cce6282658f52aeb3063cc08799ac`, was published at `2026-10-12T08:36:11Z` and installed at observed host time `2026-10-12T08:53:29.0786995Z`. ZIP SHA-256: `0717db2b8dcc7811373b04035513d1d7ed66042e7fc1e8bc475acb169601037e` (15,557,032 bytes).

Exact-release Node PID 3400 runs beneath the intended WinSW service as NetworkService, exclusively listening on `127.0.0.1:3000`; public HTTP :8443 readiness passed. Private environment and proxy hashes, IIS configuration, the protected consumer and signing key were retained. An initial activation failed before any service switch, version-record or release-folder change; inspection confirmed runtime 14 healthy before the successful retry. Its exact failure cause was not established. Live HTTP acceptance passed eight groups and five public GETs (all 200), at workstation UTC `2026-10-12T08:48:28.676Z`–`2026-10-12T08:48:59.459Z` (the host clock is about five minutes ahead). Portal polling repeated after 4,816 ms and Users polling after 2,785 ms within its existing timer phase. Filters, focus, scroll and unchanged table data were retained; desktop/mobile checks covered three PCNs, four assigned/six pending accounts, the yellow marker and 390-pixel fit. HTTP cookies, session reload and logout passed. Only login/logout writes were permitted; no business changes, external requests, directory lookup attempts or unexpected errors occurred. Profile reads were configured to be locally stubbed to prevent server-side directory-flow calls; none occurred. Two notification-health GETs were blocked locally. No test mail was sent. The ignored report is `test-results/live-auto-refresh-acceptance.json`.

At observed host time `2026-10-12T08:56:27.2819451Z`, a repeat consumer invocation returned `already_current` for runtime 15, retained Node PID 3400 and resumed the task. Independent final checks at `2026-10-12T08:57:26.6256694Z` confirmed release 15 / commit `73009ce7272cce6282658f52aeb3063cc08799ac`, service Running, sole `127.0.0.1:3000` listener owned by PID 3400, sole PCNTest HTTP `172.30.77.137:8443:` binding, access SSL flags 0 with no SSL mapping, SQL readiness, unrelated Default Web Site HTTP :80 returning 200, and the SYSTEM task enabled / Ready / last result 0.

### Historical HTTP conversion — pcn-test-14-1

[Actions 38215492045](https://github.com/akwaa2545-gif/PCN-/actions/runs/38215492045) passed 605 unit/API tests, the isolated browser suite and the high/critical dependency audit gate. Signed [pcn-test-14-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-14-1) from main `4ef5da534484b8ad173348fe51729d391f115c1b` was installed at observed host time `2026-10-12T07:15:07.8901976Z`. Archive SHA-256: `3d0c4b9c2a08ef699bb69e15d5769bbd1873f01777f79e7f0185bf5d8a675ce5`.

The user-authorized internal HTTP conversion retained **the same port 8443**, at `http://172.30.77.137:8443`. Only private `PUBLIC_ORIGIN` and `ALLOW_INTERNAL_HTTP` values, the exact PCNTest IIS / HTTP.sys binding and PCNTest's Require SSL access setting changed. The effective access `sslFlags` is 0; rollback restores 8. `NODE_ENV=production`, loopback backend, proxy web.config/client-IP overwrite, employee-network firewall restrictions and private SQL/mail values were retained. HTTP uses `pcn_session_http` with HttpOnly, SameSite Strict, exact-origin and CSRF enforcement; its traffic is unencrypted. GitHub downloads and Power Automate integrations still require HTTPS. The pending corporate certificate request is retained only for an optional HTTPS return.

Exact-release HTTP Node PID 18368, workstation SQL readiness / login-page checks and unrelated HTTP :80 passed. Browser acceptance passed six groups, five public GETs (all 200) and sixteen read-only API responses, with no unexpected errors. It covered automatic employee-code sign-in, the separate HTTP cookie, persisted reload, old Secure cookie isolation, two expected 403 origin/CSRF logout probes retaining the session, Portal records, assigned/pending Users filters and yellow marker at desktop/mobile widths, read-only document History / print and final logout clearing the HTTP cookie. Only login/logout and two rejected auth probes were sent; notification-health requests were blocked locally, with no business writes, external requests or mail. At observed host time 2026-10-12T07:52:26.4834039Z, a repeat consumer poll returned already_current for runtime 14 and retained Node PID 18368. Independent final checks at 2026-10-12T07:52:46.7647158Z confirmed the service Running, sole 127.0.0.1:3000 listener, sole PCNTest HTTP :8443 binding, sslFlags 0, absent SSL mapping, readiness ready, unrelated HTTP :80 returning 200, and the polling task enabled / Ready / result 0.

### Historical HTTPS deployment — pcn-test-13-1

[Actions 38205693461](https://github.com/akwaa2545-gif/PCN-/actions/runs/38205693461) passed 600 unit/API tests, the isolated browser suite and the high/critical dependency audit gate. Signed [pcn-test-13-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-13-1) from main `ae9e86bf4365d8f96b7fff65d0eb58eaaa672dbc` was installed at observed host time `2026-10-12T05:12:29.8604841Z`, after host-side validate-only signature/archive/path checks. Archive SHA-256: `eefb60ae20ef6f10bf561833504246d9de4fa34e7b808151adae1c8751129dc9`.

The existing consumer/public-key hashes below were preserved. Independent checks confirmed Node PID 19360, WinSW parent PID 6300, the exact new release command, NetworkService ownership and exclusive loopback port 3000. Trusted HTTPS readiness/authentication and unrelated HTTP :80 returned 200. Fourteen public assets matched after line-ending/BOM normalization; private source/configuration paths returned 404. Migration 006 was already applied during the separately recorded startup repair; deployment ran no migrations, bootstrap or account import.

Live trusted HTTPS acceptance passed nine groups and seventeen read-only API responses, all 200. It covered automatic administrator login/logout, Portal records, pending/assigned Users filters and yellow indicator, Add role/Create user desktop/mobile dialogs, disabled Save without selected mail, read-only Mail Routing and existing document controls. Only login/logout writes were permitted, all notification endpoints were blocked locally, and no business writes or test emails occurred. There were no page errors, unexpected console errors or failed responses; the deliberate notification block generated one expected resource error. Local coverage is separate: 600 tests, 91.63% lines / 90.81% branches / 93.80% functions. Live account creation/role removal, record saves, scanning, signing and notification delivery were not exercised. The scanner remains disabled and pending files quarantined.

The SYSTEM polling task is resumed enabled / Ready / result 0. A repeat consumer poll returned `already_current` for `pcn-test-13-1`, preserving Node PID 19360 and the exact release/commit state.

### Historical document-control deployment — pcn-test-12-1

[Actions 37891473630](https://github.com/akwaa2545-gif/PCN-/actions/runs/37891473630) succeeded with 444 unit/API tests, 120 existing browser checks and the high/critical dependency audit gate. Signed [pcn-test-12-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-12-1) from main `a5777eb9b92887b29b4f85aeb68614c79fadc294` was installed at observed host time `2026-10-09T06:11:55.8831811Z`.

The independently upgraded protected consumer changed only its public asset allowlist and has SHA-256 `9D245F204BFF2F533A1A14DA27146022BC0F9BFD31F2847515E9E53472A19DD2`. Its protected backup and ACL were preserved; the pinned public-key SHA-256 remained `04D893A9C5021114C816C9DA5BDD5D7A80EA6E061C6573CACB9196CC38EA3306`.

Independent checks verified Node PID 14956 running the exact release beneath WinSW as `NT AUTHORITY\NETWORK SERVICE`, exclusively listening on `127.0.0.1:3000`. Public HTTPS :8443 returned SQL readiness 200 and employee-code auth mode; unrelated Default Web Site HTTP :80 still returned 200. The SYSTEM polling task is enabled / Ready / result 0. A repeat poll returned `already_current` for `pcn-test-12-1`, preserving Node PID 14956 and the pinned public key. Read-only schema inspection confirmed migrations 001–005 already applied; deployment ran no DDL, account import, business-data mutation or test email.

The scanner remains disabled, so pending attachments stay quarantined. Trusted HTTPS browser acceptance passed 10 groups and 17 read-only API responses (all 200), covering existing administrator sign-in/logout, records, Users, Mail Routing and an existing PCN's document controls at desktop and 390-pixel widths. It used no TLS bypass and produced no console/page errors, business writes or external integration calls. Eleven live public assets matched the deployed commit after line-ending normalization; private source/configuration paths returned 403/404. Live upload, real scanning, saving, signing and notifications were outside acceptance. The 13 document browser groups and 91.08% line coverage remain prior local results, separate from CI.

### Historical employee-code cutover — pcn-test-10-1

[Actions 37567205169](https://github.com/akwaa2545-gif/PCN-/actions/runs/37567205169) succeeded with 240 tests, 59 isolated browser checks and the high/critical audit gate. It published signed [pcn-test-10-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-10-1) from main `c827d9c1c23c27631604936807dbbc352101c11e`, installed at observed host time `2026-10-07T03:42:57.7868092Z`. Real HTTPS acceptance passed 26 checks with certificate/IP verification and no Windows challenge. The exact NetworkService / WinSW / loopback identity passed, unrelated Default Web Site HTTP :80 remained available, and the enabled SYSTEM polling task is Ready / result 0 with a verified no-op repeat. The [main acceptance record](employee-code-authentication.md#acceptance--2026-10-07) records source/account/schema and local-browser evidence; actual user Edge GUI and email delivery remain unobserved.

### Historical former-auth runtime — pcn-test-9-1

[Actions 37562025155](https://github.com/akwaa2545-gif/PCN-/actions/runs/37562025155) succeeded and published signed [pcn-test-9-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-9-1) from `9b00da23`. The host recorded deployment at observed server time `2026-10-07T02:41:51.5138466Z`; its clock differed from the workstation. This release used the former Windows-authentication model and was superseded by 10-1.

Earlier `pcn-test-8-1` from `9f23256` passed 243 unit/API integration tests and 59 isolated browser checks in Actions 37559651975. The installed consumer verified NetworkService ownership, exact release directory, WinSW parent and exclusive loopback binding, and the polling task was Ready/result 0. Twelve real SSPI checks passed before/after that release. Successful Edge GUI access was not established, and those results are historical evidence rather than employee-code acceptance.

### Historical SQL/mail deployment — pcn-test-6-1

[Actions run 37426439232](https://github.com/akwaa2545-gif/PCN-/actions/runs/37426439232) succeeded with 155 tests, 16 isolated browser checks, the high/critical dependency audit gate, packaging/signing and publication. It released [pcn-test-6-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-6-1) from main commit `359e1c43e39b30ec8ef1ebfbed30daa0bd54d939`. The ZIP SHA-256 is `025e8eb72c849b09b97e5f68e7bdd2d3adc2de672136542bf6674af885935829`.

At that rollout, the host recorded deployment at `2026-10-06T07:06:27.3234975Z` and last-deployed state matched that release/commit. The SYSTEM task was Ready with result 0 and the service was Running. Independent checks confirmed the exact `C:\SupplierPCN\releases\pcn-test-6-1\server.js` command, LocalService owner, WinSW service parent, exclusive `127.0.0.1:3000` listener and pinned-certificate HTTPS SQL readiness.

Private directory configuration was updated separately under the deployment mutex, retaining its ACL/backup and existing mail/SQL values after a zero queued-job check. That configuration update caused no flow invocation, SQL mutation or restart; deployment then restarted the service with the protected external configuration. Mail configuration validates locally, a host backend directory lookup returned one matching profile with an inline photo, and compact Mail service HTML was checked. No test email/delivery verification or actual authenticated client health/directory UI is claimed. Signed URLs and identifying profile data remain private.

### First pipeline history — pcn-test-5-1

The first live pipeline completed on 2026-10-06. [Actions run 37411798943](https://github.com/akwaa2545-gif/PCN-/actions/runs/37411798943) passed all 134 unit/API tests, all seven isolated browser checks, the high/critical dependency audit gate, packaging, signing and publication. It published [pcn-test-5-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-5-1) from commit `6170a0fe80d249314dfe2e50d5378490ef9107fd`.

The installed SYSTEM task completed with result 0 and recorded `deployed` at `2026-10-06T04:13:57.8149751Z`. Its protected `last-deployed.json` records that release and commit. An independent check confirmed Node runs `C:\SupplierPCN\releases\pcn-test-5-1\server.js` as LocalService, is a child of the intended WinSW service, listens only on `127.0.0.1:3000`, and passes SQL readiness. A subsequent poll returned result 0 and `already_current`; the service process and successful deployment record remained unchanged.

HTTPS probes through IIS validated the pinned certificate and IP identity, readiness/login/anonymous session responses, unauthenticated PCN denial, source/configuration denial, proxy-header overwrite and foreign-origin rejection. Authenticated pilot login and observed client browser certificate trust remain separate acceptance checks; deployment made no test PCN writes or password changes.

The release archive SHA-256 is `2b8ec7836bf231bd325dc17c14e5f93626236b2bb8bb9ce5d4f1fc5598ba846c`. The installed public-key PEM file SHA-256 is `04d893a9c5021114c816c9da5bdd5d7a80ea6e061c6573cacb9196cc38ea3306`. These identify the accepted artifact and independently installed trust anchor; retain the protected host records for subsequent maintenance.

Local PowerShell 5.1 fixtures passed 42 assertions covering extraction, malicious/duplicate/link/conflicting entries, version ordering/replay rejection, atomic replacement, XML preservation and rollback without advancing successful state. The build tests verify signature tampering/wrong keys/schema rejection and producer-to-server extraction compatibility. Rollback was tested with isolated fixtures, not deliberately triggered against the live service. The dependency audit still reports three moderate entries in the `sprintf-js`/Tedious/mssql chain; no high/critical advisory blocked this release.
