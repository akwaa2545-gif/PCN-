# Windows internal deployment and employee-code cutover

Updated: 2026-10-16. Signed `pcn-test-18-1` is installed on the existing HTTP :8443 origin. CI, exact-release identity, public asset hashes, SQL readiness and five live browser groups passed. Host preflight confirmed migrations 001–007 already applied with matching checksums. Repeated protected-consumer and SYSTEM task runs returned `already_current` with Node PID 6008 unchanged; the task is enabled / Ready / last result 0. Previous runtime evidence is preserved below.

## Scope and retained components

The limited pilot runs on `THCHA-WEBHOST01`, Windows 10 Pro, at `http://172.30.77.137:8443`, with the separate IIS `PCNTest` site/application pool and `SupplierPCNTest` WinSW service. Node serves application routes/static files only through `127.0.0.1:3000`. Default Web Site's `*:80` binding was verified unchanged and responds HTTP 200.

The replacement data flow is:

```text
Browser employee code -> IIS HTTP :8443 -> Node 127.0.0.1:3000
                                           | PCN users / sessions / roles -> Scn_DB
                                           | read-only employee lookup   -> KEY_Code_DB.dbo.tblEmployee
```

Both databases are on the configured server `svr120a`. The source table has 1,935 inspected records, unique non-null `EmpCode` text up to ten characters, names, job title and source department. It has no email/active flag. Source-backed accounts revalidate source presence and active PCN account/session state; PCN-local accounts use PCN account/session state. Assigned roles enable actions; active roleless employee accounts use read-only Records. The source remains read-only; no bulk employee import or synchronization is performed.

The host has Node.js 26.10 and WinSW 2.12.0. The service currently runs as exact `NT AUTHORITY\NetworkService`, with its unique `NT SERVICE\SupplierPCNTest` SID enabled. Its previous process owner, parent, loopback listener and SQL readiness were verified. Changing the application auth mode does not require weakening these service-SID ACLs or giving the shared NetworkService account access to SQL secrets.

IIS on Windows 10 Professional permits ten concurrent requests, so this remains a limited pilot; wider use requires appropriate Windows Server capacity and maintenance. [Microsoft IIS request restrictions](https://learn.microsoft.com/en-us/iis/troubleshoot/request-restrictions).

## Release and configuration isolation

| Component | Retained deployment layout |
|---|---|
| Current release | `C:\SupplierPCN\releases\pcn-test-18-1` |
| Release directories | `C:\SupplierPCN\releases\pcn-test-<runNumber>-<runAttempt>` |
| WinSW service / logs | `C:\SupplierPCN\service` / `C:\SupplierPCN\logs` |
| Private backend environment | `C:\ProgramData\SupplierPCN\config\pcn.env`, selected by absolute `PCN_ENV_FILE` |
| Backend binding | `127.0.0.1:3000` only |
| Browser origin | Exactly `http://172.30.77.137:8443` |
| Runtime identity | `SupplierPCNTest` as NetworkService with service-SID-specific ACLs |
| IIS identity | Separate PCNTest application pool, no SQL/environment-secret access |

SQL passwords and signed mail/directory URLs remain outside Git, releases, WinSW XML, IIS configuration and logs. The unique service SID reads the private backend file and selected release; administrators/SYSTEM control maintenance. A downloaded release cannot replace the protected deployment consumer/public key. The source table connection is a read-only query through the protected SQL connection, not a browser credential.

The replacement nonsecret runtime configuration is:

```text
AUTH_MODE=employee-code
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
NODE_ENV=production
PUBLIC_ORIGIN=http://172.30.77.137:8443
ALLOW_INTERNAL_HTTP=true
```

`employee-code` is the normal runtime default. Explicit `AUTH_MODE=password` is maintenance access for eligible unlinked legacy accounts. Obsolete AD/Windows settings and proxy secrets are removed from the replacement environment; their presence must not activate Windows mode. Normal employee-code sign-in requires neither a PCN password nor a Windows-authenticated browser.

## Historical employee-code cutover sequence

1. Pause the `SupplierPCNTestDeployment` SYSTEM polling task for reviewed cutover; preserve its trust anchors, version records and current service/IIS configuration. Keep the live application running during preparation where possible.
2. Confirm the intended administrator's source `EmpCode` with the user. The former AD SamAccountName is not assumed to identify the same SQL-source employee. For this rollout create the separately approved `2205529` Administrator / IT account; preserve the prior accounts and their ownership without relinking the unrelated former AD administrator.
3. Check protected SQL/source connectivity and preserve an appropriate before-state. Apply reviewed migration 003 to `Scn_DB`, then verify readiness. Startup/deployment does not run DDL. The source `KEY_Code_DB` table must remain unchanged.
4. On **PCNTest only**, enable Anonymous Authentication and disable Windows Authentication. Archive/remove its old Windows identity module and separate key file/configuration. Retain HTTPS, certificate validation and other IIS sites.
5. Keep the ordinary loopback proxy and overwrite `X-PCN-Client-IP` with observed `REMOTE_ADDR` on every request, including forged caller values. Remove Windows identity forwarding; no AD header is authentication evidence for the replacement.
6. Set employee-code mode in the private backend environment, validate the reviewed signed replacement runtime and installed consumer, switch only the PCN service and verify exact Node/WinSW identity, loopback listener, schema/SQL/source behavior.
7. Verify real employee-code administrator login/session/authorization/logout through HTTPS, selected user creation/linking and source-outage denial; retain cookie/origin/CSRF protections and PCN signing/ownership permissions. Record the actual release and results before resuming the task.

The earlier employee-code rollout completed this sequence. PCNTest has Windows Authentication disabled / Anonymous Authentication enabled with empty anonymous username and its existing pool identity. The obsolete Windows module DLL/key were archived in protected maintenance storage and removed from the live site. Existing pool read/execute permissions, the then-current HTTPS binding, service-SID secret isolation and native `REMOTE_ADDR` client-IP rewrite were retained. Real GUI automation against the local SQL-backed runtime passed; the user's own Edge observation remains separate.

## Internal HTTP conversion

Automatic browser updates were introduced in runtime 15 and are retained in runtime 18. They reuse existing authorized GET APIs every five seconds on visible pages and redraw only changed data, preserving filters, focus and scroll. Busy actions, dialogs and Mail Routing drafts defer updates; hidden pages pause and failures back off to thirty seconds. Saved PCNs refresh automatically when clean; unsaved edits retain their original saved version and receive a **Reload latest** notice with discard confirmation. The helper is contained in the existing `session-client.js` asset, so deployment needs no new public asset, protected-consumer update or IIS change. Refresh performs no SQL writes or mail calls. Runtime 15's live acceptance remains historical evidence below.

The user selected HTTP on the existing port **8443**, at `http://172.30.77.137:8443`. Runtime `pcn-test-14-1` permits this only with an exact RFC1918 literal IPv4 origin, loopback backend and `TRUST_PROXY=loopback`. `NODE_ENV=production` remains enabled. The private configuration changes were exactly:

```text
PUBLIC_ORIGIN=http://172.30.77.137:8443
ALLOW_INTERNAL_HTTP=true
```

The scoped operation converted only the IIS `PCNTest` binding at `172.30.77.137:8443` from HTTPS to HTTP, removed its exact HTTP.sys SSL mapping, and cleared PCNTest's Require SSL access setting (`sslFlags` 8 to 0). The existing certificate remains in LocalMachine My for rollback or a future HTTPS return. The existing `SupplierPCNTest-HTTPS` firewall rule retains TCP 8443, its employee-network scope and Domain/Private profiles despite its historical name. Proxy web.config, unrelated IIS sites, private SQL/mail values, service identity and loopback-only backend remain unchanged.

The first HTTP conversion encountered IIS 403.4 because the effective access setting still required SSL (`sslFlags` 8); an initial preflight read of `sslFlags.Value` had returned null. Full HTTPS rollback succeeded. The corrected operation reads `access.Attributes`, preserves the Require SSL value for rollback and verified effective `sslFlags` 0 before HTTP readiness. The successful conversion retained a protected backup at `C:\SupplierPCN\deployment\http-transition\20261012T074810Z-0a08c12e8f0d435bb9bf9c5c6a9c0980`. The resulting private environment file SHA-256 is `ED6EFB877E4E9A53BD36337DB727B61B27683E0051AF6B2C9F222B01A4A74E25`; its contents remain private. Current HTTP readiness returned `ready` and `/login` returned 200 from the workstation. Six HTTP desktop/mobile browser groups passed; polling is enabled / Ready / result 0.

HTTP traffic is unencrypted. A separate `pcn_session_http` cookie avoids collisions with existing Secure `pcn_session` cookies on the same IP. HttpOnly, SameSite Strict, exact-origin, CSRF, authorization and rate limits remain enabled. Server-side Power Automate and GitHub connections retain their HTTPS requirements. Host readiness, six desktop/mobile browser groups, task resumption and a repeat no-op consumer check passed; final evidence is recorded below.

## Historical TLS and client setup; optional HTTPS return

The earlier HTTPS binding used certificate thumbprint `B3691FE671FDCB46718B8E4AC7EA5B9EDEDF64FB`, expiring on 2027-01-04. Pinned-certificate IP validation passed. The approved client's Current User Root store contains the verified public certificate; normal operating-system TLS trust passed without a custom CA file or TLS bypass. The certificate and private key remain on the server; the authorized HTTP conversion does not export or delete them.

The current user's HTTPS IP `172.30.77.137` was mapped to Local Intranet zone 1 during the former Windows-auth pilot. That mapping covers all HTTPS ports at this IP, with no HTTP/subnet/domain-wide mapping or credential-delegation/authentication-allowlist change. Employee-code login does not need that zone mapping for native SSO. Protected rollback metadata remains under `%LOCALAPPDATA%\SupplierPCN\deployment\sso-operations\backups\pcn-browser-before-*.json`; restore only the scoped client state if retiring it, retaining TLS trust required for the pilot.

Before the HTTP conversion, the HTTP.sys binding was at its verified original baseline with Disable HTTP2 Not Set and all other TLS fields unchanged. A former HTTP/1.1 trial did not resolve Edge `ERR_TOO_MANY_RETRIES` and was reverted. The former browser incident involved a VPN extension overriding native HTTP authentication challenges; its credentials are not recorded here. Those SSO diagnostics are [historical](employee-windows-authentication.md#historical-edge-incident), not setup requirements for employee-code login.

Retire the pilot trust/binding when replacing the test with an approved CA-issued certificate. Remove only the installed pilot thumbprint from the client's Current User Root store when it is no longer needed, and never export a PFX/private key.

### Historical company certificate request; optional HTTPS return (2026-10-12)

Other employee computers report `NET::ERR_CERT_AUTHORITY_INVALID` for the pilot certificate. A replacement request was generated on `THCHA-WEBHOST01` with a non-exportable 3072-bit machine RSA key, Server Authentication purpose, subject `CN=THCHA-WEBHOST01.KEMET.com`, both host DNS names and IP SAN `172.30.77.137`. The IP SAN preserves the current portal URL.

The host submitted this request as `KEMET\THCHA-WEBHOST01$` to `hq-cert2.KEMET.com\KEMET-HQ-CERT2-CA-1`, using the published `WebServerv2-new` template. **Request ID `1580097` was pending CA manager approval when checked on 2026-10-12** (disposition 5, `Taken Under Submission`; observed host UTC timestamp `2026-10-12T06:33:52.7158578Z`). The template requires approval; do not change that policy or submit a duplicate. A CA administrator must review and issue this request from that CA's Pending Requests.

Protected host artifacts are under `C:\SupplierPCN\deployment\certificate-requests\pcn-test-20261012`; the submission result is `hq-cert2-submission\result.json`. The public CSR SHA-256 is `AF7E8B7E3407671B4565D15D4A73E0496E8C6A818A961E060441B43B01DAF78E`; the requested public-key SHA-256 is `855FA80FCB54756F86C6B21E0907709526DC7C93E617C5D6A3F7293E2D4DAE9F`. No private key was exported.

For an explicitly authorized future HTTPS return after issuance, retrieve request `1580097`, verify its key match, subject/SANs, Server Authentication purpose, validity and trusted company chain, then accept it into the host machine store. Restore only the `PCNTest` HTTPS binding on `172.30.77.137:8443`, set the matching HTTPS `PUBLIC_ORIGIN` and disable `ALLOW_INTERNAL_HTTP`, then verify normal certificate validation, Secure cookies and application readiness. Keep the former pilot thumbprint above for rollback. The discovered issuing CA chains to `KEMET-HQ-CERT1-CA` (root thumbprint `4815A950F4A2DD55E8C57F4584EE853638A6A562`), which is trusted on the host and this workstation; trust on the affected employee computer still needs verification.

At that check, the certificate had **not** been issued or installed. Post-submission checks confirmed the original binding, service Running, readiness `ready`, and removal of the temporary submission task. This request does not block the explicitly authorized HTTP deployment. Returning to HTTPS requires issuance, certificate installation, restored HTTPS origin and Secure cookies, and client trust verification; HTTP itself uses no server certificate.

## Historical release evidence

[Actions 37562025155](https://github.com/akwaa2545-gif/PCN-/actions/runs/37562025155) succeeded and published signed [pcn-test-9-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-9-1) from `9b00da23`. The observed host deployment timestamp is `2026-10-07T02:41:51.5138466Z`; its clock differed from the workstation. It included the Retry authentication card visibility fix, verified by two extra assertions in the existing 59-check isolated browser run. This release has the former Windows authentication model, not the replacement code-only design.

Earlier `pcn-test-8-1` from `9f23256` passed 243 unit/API integration tests and 59 isolated browser checks in Actions 37559651975. Twelve real curl SSPI checks passed before/after that deployment. The installed consumer independently verified the exact release directory, NetworkService owner, WinSW parent and exclusive loopback listener; the SYSTEM polling task was enabled / Ready with result 0 at that final check. Those former SSO results do not verify employee-code login.

`pcn-test-6-1` from `359e1c43e39b30ec8ef1ebfbed30daa0bd54d939` passed 155 tests / 16 isolated browser checks in Actions 37426439232 and deployed on 2026-10-06 as LocalService. Its ZIP SHA-256 was `025e8eb72c849b09b97e5f68e7bdd2d3adc2de672136542bf6674af885935829`. SQL readiness, compact Mail service HTML and a backend recipient lookup with an inline photo passed; email delivery did not.

The first pipeline release `pcn-test-5-1` passed 134 tests / seven browser checks and deployed at `2026-10-06T04:13:57.8149751Z`. A repeat poll returned `already_current` without changing the service. Historical unauthenticated/source/proxy/origin checks passed in its password mode; they are not replacement acceptance evidence.

## Current acceptance and recovery

### Current runtime — pcn-test-18-1; application and Mail Routing improvements

[Actions 38714287181](https://github.com/akwaa2545-gif/PCN-/actions/runs/38714287181) completed all 23 steps successfully and published signed [pcn-test-18-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-18-1) from commit `1edcec3bb13dce5df6e7d6cd4c079334a5f8aec9` at `2026-10-15T09:42:24Z`. ZIP SHA-256: `108bb30d4afbc217a4972d6c1a4c90539e1680678b525f65104704b8e508c1cc`. The final local suite passed 971/971 tests with 88.34% line / 91.04% branch / 94.69% function coverage; the audit found no high/critical advisories. CI includes the guided Create, Developer Tools, user-presence and Mail Routing browser gates alongside the existing workflow, automatic-update, timeline, signing-order, Records and Developer-access checks.

The release includes the dedicated Create page and marked testing documents, Developer-only workflow/transaction tools and protected Developer assignments, Prepared → Checked → Approved signing and next-action routing, department-scoped Administrator update mail, the Records dashboard with gold Open PCN links and icon actions, department signing summaries, authenticated Online/Offline presence and the supplied Segoe UI Semibold table font. Mail Routing has one **Assign user** action per department header, an explicit signing-role/verified-directory popup and expandable department lists. These popup edits remain unsaved routing changes until **Save Mail**; they do not grant signing access or send mail.

Before validation, the protected host consumer was independently updated only for its runtime-file allowlist, with a protected backup and ACLs retained. Consumer SHA-256: `36D8433E617345CE405788A9DB6722D7C5B4BA759FA4BA87E9BA66C8CF5A47B6`. The verifier and pinned public key were unchanged; public-key SHA-256 remains `04D893A9C5021114C816C9DA5BDD5D7A80EA6E061C6573CACB9196CC38EA3306`. A scoped private configuration change added the Developer assignment hash with backup and ACLs preserved; other configuration was retained. The Developer assignment credential remains private. Read-only checks of the host's configured SQL target confirmed migrations 001–007 were already applied and every checksum matched source. No DDL, bootstrap, account/role changes, PCN/recipient writes or test mail were performed by these checks.

Validate-only succeeded at observed host time `2026-10-15T09:49:16Z`, preserving runtime 17 and Node PID 9280. Activation completed at observed host time `2026-10-15T09:50:39.4118586Z`. Independent checks at `2026-10-15T09:52:14.7555897Z` confirmed exact-release Node PID 6008 beneath WinSW parent PID 12092, `NT AUTHORITY\NETWORK SERVICE` ownership and the exclusive `127.0.0.1:3000` listener. Public readiness returned `ready`; unrelated HTTP :80 returned 200. All 21 checked public assets matched the release, including the exact font bytes and `font/ttf` MIME; `.env`, SQL configuration source and the deployment script returned 404. The existing public origin `http://172.30.77.137:8443` and loopback backend `127.0.0.1:3000` are retained.

Fresh guarded live browser acceptance passed five groups and exited successfully at workstation UTC `2026-10-16T01:27:44.270Z`; the host clock is recorded separately. It covered the gold Open PCN link, department timeline, Users presence and Developer menu/badges, all five Mail Routing department-header assignment controls with role selection, cancel and collapse at desktop and 390-pixel widths, and the four Create choices. The real table font loaded at weight 600, with Supplier/Material at 16 px and Open PCN at 14 px. Only existing-account login/logout writes were allowed and the session was signed out. No business changes, directory calls, operational mail, external writes, page errors or failed responses occurred. The successful fresh run followed an interrupted run that performed no authenticated API reads or authentication writes; the interrupted run is not acceptance evidence. The ignored report is `test-results/live-professional-ui-acceptance.json`.

Fresh host checks at `2026-10-16T01:31:55.4535925Z` retained release 18 / commit `1edcec3bb13dce5df6e7d6cd4c079334a5f8aec9`, exact-release Node PID 6008 and WinSW parent PID 12092. A repeat protected-consumer invocation returned `already_current` at `2026-10-16T01:33:48.0160928Z`; the SYSTEM task rerun also returned `already_current` at `2026-10-16T01:33:50.3911593Z`. Independent final checks at `2026-10-16T01:33:53.0160922Z` confirmed the task enabled / Ready / last result 0 and Node PID 6008 unchanged. No PCN save, signing, recipient change, live attachment scan or notification delivery was exercised by acceptance; scanner/quarantine restrictions remain as documented.

### Historical runtime — pcn-test-17-1; Portal timeline

Historical runtime 17: Actions **View** opens a read-only PCN timeline. Each horizontal point shows recorded time, person and a department/signing action such as **GSC/TET — Checked** or **GSC/TET — Approved**; other events show their recorded workflow status, creation or baseline. Cleared signatures and unavailable earlier history are explicit. Selection reveals before/after form and signing changes, omitting internal storage metadata. Popup scrolling is contained at mobile widths, and the existing Portal auto-refresh gate pauses while the dialog is open. The timeline uses the existing history API and adds no database migration or host configuration change.

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

[Actions 38215492045](https://github.com/akwaa2545-gif/PCN-/actions/runs/38215492045) passed 605 unit/API tests, the isolated browser suite and the high/critical dependency audit gate. Signed [pcn-test-14-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-14-1), commit `4ef5da534484b8ad173348fe51729d391f115c1b`, was installed at observed host time `2026-10-12T07:15:07.8901976Z`. Its ZIP SHA-256 is `3d0c4b9c2a08ef699bb69e15d5769bbd1873f01777f79e7f0185bf5d8a675ce5`. After the scoped HTTP conversion, exact-release Node PID 18368 served readiness `ready` and `/login` 200 at `http://172.30.77.137:8443`; unrelated Default Web Site HTTP :80 returned 200.

Live HTTP acceptance passed six groups, five public GETs (all 200) and sixteen read-only API responses at workstation UTC `2026-10-12T07:45:27.879Z`–`2026-10-12T07:45:44.227Z`, with no unexpected errors. It verified automatic administrator sign-in; `pcn_session_http` with HttpOnly, SameSite Strict, Secure false and root path; an existing synthetic Secure `pcn_session` staying unsent over HTTP; persisted login after reload; wrong-Origin and missing-CSRF logout probes each returning 403 while retaining the session; three Portal PCNs; Users with four assigned / six pending accounts, filters and yellow indicator at desktop and 390-pixel widths; read-only existing-document History / print; and successful logout clearing only the HTTP cookie and authenticated session. Exactly login, logout and two rejected auth probes were sent. Two automatic notification-health GETs were blocked locally; no business writes, external requests or test mail occurred. The live report is retained in ignored `test-results/live-http-acceptance.json`.

At observed host time 2026-10-12T07:52:26.4834039Z, the repeat consumer poll returned already_current for runtime 14 with Node PID 18368 unchanged. Independent final checks at 2026-10-12T07:52:46.7647158Z confirmed exact release / commit, service Running, sole 127.0.0.1:3000 listener, sole PCNTest HTTP :8443 binding, sslFlags 0, absent SSL mapping, readiness ready, unrelated HTTP :80 returning 200, and the SYSTEM polling task enabled / Ready / result 0.

### Historical HTTPS deployment — pcn-test-13-1

[Actions 38205693461](https://github.com/akwaa2545-gif/PCN-/actions/runs/38205693461) passed 600 unit/API tests, the isolated browser suite and the high/critical dependency audit gate. Signed [pcn-test-13-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-13-1), commit `ae9e86bf4365d8f96b7fff65d0eb58eaaa672dbc`, was installed at observed host time `2026-10-12T05:12:29.8604841Z`. Its ZIP SHA-256 is `eefb60ae20ef6f10bf561833504246d9de4fa34e7b808151adae1c8751129dc9`. The installed consumer and pinned public key retain the hashes recorded below; no trust-anchor, private configuration or IIS changes were made.

Independent verification found Node PID 19360, exact `pcn-test-13-1\server.js`, WinSW parent PID 6300, `NT AUTHORITY\NETWORK SERVICE` ownership and one listener at `127.0.0.1:3000`. Trusted HTTPS returned readiness 200 / employee-code mode; unrelated HTTP :80 returned 200. Migration 006 had already been applied during the separate startup repair, preserving the existing ten users, three PCNs, six role grants and one master-data row; the deployment ran no DDL, account import or bootstrap. Fourteen public assets matched the release after line-ending/BOM normalization; four private source/configuration paths returned 404.

Trusted HTTPS browser acceptance passed nine groups and seventeen read-only API responses, all 200: seven-digit automatic administrator login, Portal records, split Users tables, filters, yellow Pending access marker, Add role/Create user popup fit at desktop and 390-pixel widths, canceled dialogs, missing-mail Save disabled, read-only Mail Routing, existing document panels and logout. Only login/logout POSTs were allowed. Notification endpoints were blocked locally before server contact; no business writes or test emails were performed. There were no page errors, unexpected console errors or failed responses; the one deliberate notification block produced an expected browser resource error. Coverage remains separate local evidence: 600 tests, 91.63% lines, 90.81% branches and 93.80% functions. The attachment scanner remains disabled; pending files remain quarantined.

The SYSTEM polling task was resumed enabled / Ready / result 0 after acceptance. A repeat consumer invocation returned `already_current` for `pcn-test-13-1`, preserving Node PID 19360, exact release state and trust anchors.

### Historical document-control deployment — pcn-test-12-1

[Actions 37891473630](https://github.com/akwaa2545-gif/PCN-/actions/runs/37891473630) passed 444 unit/API tests, 120 existing browser checks and the high/critical dependency audit gate. Signed `pcn-test-12-1` was installed at observed host time `2026-10-09T06:11:55.8831811Z`. The protected consumer was independently upgraded only for its public asset allowlist, with a protected backup and ACL retained. Its SHA-256 is `9D245F204BFF2F533A1A14DA27146022BC0F9BFD31F2847515E9E53472A19DD2`; pinned public-key SHA-256 stayed `04D893A9C5021114C816C9DA5BDD5D7A80EA6E061C6573CACB9196CC38EA3306`.

Independent checks verified exact-release Node PID 14956, WinSW parent, `NT AUTHORITY\NETWORK SERVICE` ownership and exclusive `127.0.0.1:3000` binding. Public HTTPS :8443 returned SQL readiness 200 with employee-code authentication; Default Web Site HTTP :80 still returned 200. The SYSTEM polling task is enabled / Ready / result 0. A repeat poll returned `already_current` for `pcn-test-12-1`, preserving Node PID 14956 and the pinned public key. Read-only schema checks confirmed migrations 001–005 already applied; deployment performed no DDL, account import, business-data mutation or test email. The attachment scanner remains disabled and pending files quarantined. Trusted HTTPS browser acceptance passed 10 groups and 17 read-only API responses (all 200), covering existing administrator sign-in/logout, records, Users, Mail Routing and an existing PCN's document controls at desktop and 390-pixel widths. No TLS bypass, console/page errors, business writes or external integration calls occurred. Eleven live public assets matched the deployed commit after line-ending normalization; private source/configuration paths returned 403/404. Live upload/scanning/save/signing/notification acceptance remains separate; 13 document browser groups and 91.08% line coverage were prior local results.

### Historical employee-code cutover — pcn-test-10-1

[Actions 37567205169](https://github.com/akwaa2545-gif/PCN-/actions/runs/37567205169) succeeded with 240 tests, 59 isolated browser checks and the high/critical audit gate. Signed `pcn-test-10-1` was installed at observed server time `2026-10-07T03:42:57.7868092Z`. Migration 003 was applied at `2026-10-07T03:35:30.942Z`, with 001/002 unchanged. The separate verified `2205529` Administrator / IT account was added while retaining the prior three accounts.

NetworkService / WinSW / exclusive loopback identity and SQL readiness passed. Real HTTPS acceptance passed 26 checks with CA/IP validation and no Windows authentication challenge; the local SQL-backed headless browser passed login, Users/lookup, role/department controls and logout. Default Web Site HTTP :80 remained available. The polling task is enabled / Ready / result 0 and a repeated poll was a no-op. See [the complete acceptance record](employee-code-authentication.md#acceptance--2026-10-07) for scope, coverage and account evidence; these checks do not claim the user's Edge GUI or email delivery was observed.

Before migration 003, a DPAPI-encrypted logical export of 22 PCN tables / 121 rows passed decryption/SHA-256 verification. The SQL login lacked native backup permission; this was not a native SQL backup and full restore was not tested. Preserve that recovery limitation; the earlier 108-row export preceded migration 002.

Keep the task paused if cutover fails. Restore only a reviewed, schema-compatible release/configuration and the approved account access needed for recovery. Migration 003 retires Windows mappings and revokes sessions; switching old application files alone is insufficient to recreate former access. Do not undo operational PCN data or enable all source/retired users. Retain version high-water records and service-SID ACLs; inspect protected safe logs/readiness without exposing secrets.

To retire the test, stop only PCN resources and remove their binding/firewall exception and scoped client trust as appropriate. Do not delete either database or change unrelated IIS sites.

Related: [employee-code design](employee-code-authentication.md), [GitHub deployment](github-deployment.md), [API inventory](sql-server-api-checklist.md), [application setup](../README.md).
