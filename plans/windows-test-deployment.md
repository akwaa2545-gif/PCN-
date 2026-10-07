# Windows HTTPS test deployment

Updated: 2026-10-07. Current signed release `pcn-test-8-1` is deployed from main commit `9f23256`. CI passed 243 unit/API integration tests, 59 isolated browser checks and the high/critical dependency audit gate. Windows SSO was verified from a real domain client using curl SSPI and the pinned TLS certificate. Actual browser GUI sign-in, browser certificate trust and email delivery remain unobserved.

## Scope and components

The authorized pilot serves the SQL-backed PCN app on `THCHA-WEBHOST01`, Windows 10 Pro, at `https://172.30.77.137:8443`. It uses a separate IIS `PCNTest` site and application pool so the pilot configuration is isolated from existing IIS sites. Node handles application routes/static assets through the API server; IIS terminates HTTPS and proxies to loopback port 3000.

```text
Windows client -> IIS PCNTest HTTPS :8443 -> Node 127.0.0.1:3000 -> svr120a / Scn_DB
                  Windows Authentication     WinSW / NetworkService
                  PostAuthenticate module    read-only AD lookup -> KEMET.COM
```

This is a limited pilot. IIS on Windows 10 Professional permits ten concurrent requests; excess requests queue. That limit is about active requests, not a fixed number of signed-in users. Wider use should move to Windows Server with appropriate capacity and supported operating-system maintenance. [Microsoft IIS request restrictions](https://learn.microsoft.com/en-us/iis/troubleshoot/request-restrictions)

The host has Node.js 26.10 installed. The real Node service process runs as `NT AUTHORITY\NetworkService`; its exact owner, loopback listener and SQL-backed readiness were verified. This domain-joined machine identity also passed read-only AD lookup. These startup checks do not replace the full host compatibility/test suite. The service wrapper is pinned to stable WinSW 2.12.0; upstream identifies 2.x as the stable line. [WinSW project](https://github.com/winsw/winsw), [v2.12.0 release](https://github.com/winsw/winsw/releases/tag/v2.12.0)

The pilot connects to the existing `Scn_DB`. PCN saves and user administration persist there; no separate sandbox database is implied. The release consumer does not run migrations, imports, bootstrap or initial-account smoke scripts. Migration 002 was applied separately on 2026-10-07, preserving the original two users, then only selected AD account `2172172512501` was provisioned as administrator / department `it`. Windows SSO acceptance created and revoked normal SQL sessions, but saved no operational PCNs and sent no test mail. Recipient routing and the authorized mail/directory endpoints remain configured privately outside releases.

## Release, configuration and service isolation

| Component | Required deployment layout |
|---|---|
| Current pilot release | `C:\SupplierPCN\releases\pcn-test-8-1` |
| Future pipeline release files | `C:\SupplierPCN\releases\pcn-test-<runNumber>-<runAttempt>`; record the selected directory for each rollout |
| WinSW executable/XML and service artifacts | `C:\SupplierPCN\service` |
| Service logs | `C:\SupplierPCN\logs` |
| Private environment file | `C:\ProgramData\SupplierPCN\config\pcn.env` |
| Service environment pointer | `PCN_ENV_FILE` set to that absolute environment-file path |
| Backend listener | Loopback only, port 3000; no public inbound exposure |
| Public origin | Exactly `https://172.30.77.137:8443` |
| Process environment | `NODE_ENV=production` for Secure session cookies |
| Windows service identity | `SupplierPCNTest`, NetworkService with its unique service SID enabled for ACLs |
| IIS identity | `PCNTest` application pool, CLR v4 / Integrated, for the `PCNTest` site; read access only to its separate proxy key, no database-secret access |

Keep SQL credentials and signed integration URLs outside versioned releases. Do not put them in WinSW XML, IIS web.config, build output, documentation, source control or logs. Grant `NT SERVICE\SupplierPCNTest` read access to the private environment file; do not grant the shared NetworkService account access. Grant that service SID read/execute on its selected release and read/write on its logs. Administrator/SYSTEM maintenance access is separate. The service identity change preserved these service-specific ACLs.

The nonsecret pilot configuration is:

```text
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
NODE_ENV=production
PUBLIC_ORIGIN=https://172.30.77.137:8443
AUTH_MODE=windows
AD_DOMAIN=KEMET.COM
WINDOWS_AUTH_DOMAIN=KEMET
```

The service supplies `PCN_ENV_FILE=C:\ProgramData\SupplierPCN\config\pcn.env`; database credentials and `WINDOWS_AUTH_PROXY_KEY` are maintained privately in that file. IIS reads a separate key file through the PCN application pool identity and has no access to this backend environment file.

`PCN_ENV_FILE` must be absolute and loaded by the application before configuration validation. Relative working-directory `.env` files must not override the deployment's external configuration. The service should fail startup when its configuration is missing/unreadable rather than silently use a developer credential profile. Confirm these behaviors before acceptance.

Node's database configuration remains server-side. Use the existing SQL connection profile privately; never print the environment file to verify it. The IIS site must proxy application requests, rather than statically publishing a release directory containing source/configuration.

## Proxy and client address handling

IIS must overwrite `X-PCN-Client-IP` with its observed client address on every proxied request. A caller-supplied value must not be forwarded unchanged. The Node app trusts this custom header only when the direct socket peer is loopback; untrusted peers must use their socket address. Do not infer authority from arbitrary `X-Forwarded-For` values.

PCNTest has Windows Authentication enabled, Anonymous Authentication disabled and SSL required. The installed `scripts/iis-windows-auth/PcnWindowsIdentityModule.cs` module clears caller identity headers at BeginRequest and sets trusted headers at PostAuthenticateRequest, after native Windows authentication. URL Rewrite alone runs too early to establish that identity. The module checks TLS, the native Windows logon token, matching `LOGON_USER`, domain `KEMET`, accepted Windows authentication type and the server-observed client IP. It overwrites the Windows-user, proxy-key and client-IP headers, and strips the incoming Authorization token before ARR forwards to Node. Invalid identity or key-file failure fails closed. Its compiled boundary fixture passed 18 cases and C# / security review.

This preserves per-client login throttling behind the local proxy while preventing browser-supplied address spoofing. Bind Node to loopback and verify that port 3000 is unreachable from another machine. Keep the exact HTTPS origin in application configuration so cookie/CSRF checks use the pilot URL.

## HTTPS certificate and test-client trust

The IIS HTTPS :8443 binding uses certificate thumbprint `B3691FE671FDCB46718B8E4AC7EA5B9EDEDF64FB`, expiring on 2027-01-04. A TLS request using the pinned public certificate with IP identity verification succeeded. Its public certificate is expected at `C:\Users\Server32\Downloads\PCN-HTTPS-Test.cer`; verify that file/location before distributing it. The private key stays on the server and must never be copied with the public certificate.

For an approved test client, obtain that public `.cer` through the agreed internal channel, inspect its thumbprint against the value above, then manually import it into **Current User > Trusted Root Certification Authorities** using Certificate Manager. This pilot trust is local to that user. Do not bypass browser TLS warnings or trust a different certificate to make a test pass. Verify the browser shows a valid certificate for `172.30.77.137` after import. Browser trust has not yet been recorded as verified.

Remove the same thumbprint from the client's Current User trusted-root store after testing. Remove the pilot trust/binding when the test is retired or replaced with an approved CA-issued certificate. Renew or replace before the expiry date if testing continues. Never document/export a PFX or private key.

## Deployment sequence

1. Inspect existing IIS sites, bindings, service names and ports. Record them before adding the isolated PCNTest resources.
2. Install/copy the selected release under `C:\SupplierPCN`; run dependency installation and compatibility checks using the host's Node version. Keep secrets and private exports out of the release.
3. Configure the external environment file privately, service SID ACLs, explicit loopback listener, production origin and WinSW service restart/logging behavior.
4. Start the service and verify loopback health/readiness without exposing configuration. Failure must stop rollout until corrected.
5. Create the separate IIS site/application pool, configure HTTPS :8443 with the selected certificate, and proxy to Node. For Windows mode, follow the [SSO runbook](employee-windows-authentication.md) to enable PCN-only Windows Authentication and install the post-authentication identity module with separate key-file ACLs.
6. Verify client access, certificate trust, auth/CSRF and deep links. Recheck other sites after pilot changes.
7. Record the actual release/service/binding names and completed acceptance evidence below. Only then report the pilot URL as working.

## Verified deployment pipeline

The user requested an automated pipeline. Its [separate runbook](github-deployment.md) describes GitHub-hosted Windows CI tests, an Ed25519-signed public prerelease containing only production runtime files, and the `SupplierPCNTestDeployment` SYSTEM task with highest privileges, scheduled every ten minutes and at startup. This design uses neither an internet-facing deployment listener nor a self-hosted GitHub runner. GitHub holds the release-signing secret; SQL credentials remain on the deployment host.

[Actions run 37559651975](https://github.com/akwaa2545-gif/PCN-/actions/runs/37559651975) passed all steps, including 243 unit/API integration tests, 59 isolated browser checks and the high/critical dependency audit gate. It published signed [pcn-test-8-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-8-1) from main commit `9f23256`. The host's deployment log records installation of 8-1 by the resumed SYSTEM polling task on 2026-10-07; the service is Running as NetworkService. The polling task is enabled / Ready with LastTaskResult 0. Server timestamps were observed to differ from the workstation clock, so this record uses the observed rollout date rather than asserting exact elapsed time.

Windows SSO and authenticated API requests passed from the real domain client before and after the automatic 8-1 restart: all 12 checks passed again with the same selected administrator / `it` department. The installed consumer's `Assert-PcnBackend` independently verified the exact 8-1 working directory, NetworkService Node owner, WinSW parent and exclusive `127.0.0.1:3000` listener; Windows auth configuration and SQL readiness also passed. The protected consumer was updated for the new runtime allowlist and exact NetworkService owner before release cutover; repository changes alone would not update that trust anchor.

Historical 2026-10-06 evidence: signed `pcn-test-6-1` from commit `359e1c43e39b30ec8ef1ebfbed30daa0bd54d939` passed 155 tests / 16 isolated browser checks in [Actions 37426439232](https://github.com/akwaa2545-gif/PCN-/actions/runs/37426439232), deployed at `2026-10-06T07:06:27.3234975Z` and ran as LocalService. Its ZIP SHA-256 was `025e8eb72c849b09b97e5f68e7bdd2d3adc2de672136542bf6674af885935829`. HTTPS SQL readiness, compact Mail service HTML, valid local mail configuration and a backend recipient lookup with an inline photo passed. That release preceded employee provisioning / Windows SSO; neither those historical checks nor the present SSO checks verify email delivery.

First-pipeline history: `pcn-test-5-1` passed 134 tests/seven browser checks and deployed at `2026-10-06T04:13:57.8149751Z`. Its repeated poll logged `already_current` without changing the service PID/state. Initial HTTPS login/session, unauthenticated/source denials, overwritten client-IP header and foreign-origin checks passed; those historical checks did not perform authenticated pilot login or database writes.

## Acceptance record

The following table distinguishes live host/client evidence from isolated automated tests. Real Windows client checks used curl SSPI with the pinned certificate; the 59 browser checks used isolated adapters, and do not establish live browser GUI or PCN-save behavior.

| Check | Required evidence | Status |
|---|---|---|
| Host and listener | THCHA-WEBHOST01; IIS PCNTest HTTPS :8443; Node 127.0.0.1:3000 only; workstation cannot connect to :3000 | Verified |
| Runtime compatibility | Windows Node 26 CI: 243 tests/59 isolated browser checks; deployed SQL readiness | Verified CI/startup; tests use isolated adapters |
| Service identity and ACLs | SupplierPCNTest Running; NetworkService owner/WinSW parent; service-SID configuration/release ACLs, no shared-account environment read grant | Verified after identity cutover and 8-1 deployment |
| External configuration | Absolute PCN_ENV_FILE external to release, protected service-specific configuration | Installed; missing-file startup behavior verified by focused runtime-env tests |
| Health/readiness | HTTPS health/readiness return 200 through IIS with certificate/IP verification | Verified |
| Certificate | Binding thumbprint/expiry and pinned-certificate TLS IP check | TLS verified; user reports client trust done, actual browser trust not observed |
| Windows login/session | Real domain client authenticates as provisioned employee; session, master data, admin users and own AD lookup succeed; valid logout ends PCN session | All 12 real curl SSPI checks passed before and after 8-1 restart; GUI not observed |
| API/static boundaries | IIS requires Windows authentication; backend applies PCN role/session authorization and keeps environment/source/src private | Isolated automated coverage; earlier password-mode 401/404 checks are historical |
| Origin, CSRF and proxy headers | Forged Windows identity headers replaced; password endpoint 403; missing-CSRF logout 403; valid logout 200 and logged-out session | Verified real client; historical foreign-origin/client-IP checks also passed |
| PCN navigation | Admin, create, saved PCN deep links and browser refresh through IIS | Pending |
| Data behavior | Migration 002 applied separately; original two users preserved; one selected AD administrator added, no bulk import | SQL readiness and provisioning verified; no operational PCN save tested |
| Isolation | Existing Default Web Site `*:80` binding unchanged and HTTP responds 200 | Verified; broader site regression pending |
| Restart | Service restart returns Running as NetworkService with loopback listener, SQL readiness and working Windows SSO | Verified host startup and all 12 repeated real client checks |
| Polling task | SupplierPCNTestDeployment SYSTEM/Highest, every ten minutes plus startup; resumed after SSO maintenance and automatically installed 8-1; enabled / Ready / LastTaskResult 0 | Verified deployment log and final task state; prior 5-1 no-op poll retained as history |
| Pipeline | Actions 37559651975 passed; signed pcn-test-8-1 installed from commit 9f23256 | Verified |
| Mail/directory configuration | Private endpoints loaded on release restart; valid local mail configuration and one matching inline-photo profile from host backend lookup | Verified backend configuration/lookup; no test email or real client UI claim |

Current Windows CI passed 243 tests and 59 isolated browser checks. These automated results and the real curl SSO checks are separate evidence: browser adapters isolate test state from Scn_DB, while the real SSO checks exercised Windows authentication and normal SQL sessions. Neither verifies email delivery or a live browser GUI session.

For save testing, record the test PCN identifiers and distinguish test records from operational records because writes persist in the existing database.

## Operations and rollback

Employee provisioning and Windows authentication are deployed and enabled. Follow [the SSO runbook](employee-windows-authentication.md) for identity mappings, API contracts and rollback. Migration 002 was applied at `2026-10-07T01:31:43.572Z`; startup checks schema readiness but performs no DDL. Only selected AD users are granted PCN roles; domain membership alone does not create an account.

The SQL login lacked native `BACKUP DATABASE` permission. A DPAPI-encrypted logical export of 22 PCN tables / 108 rows was created and decryption verified before migration 002. It is not a native database backup, and a full database restore was not tested. Keep this limitation in the recovery record and arrange a DBA-controlled native backup for ongoing operations.

The protected installed deployment consumer now admits the AD helper / admin-user runtime files and requires the exact NetworkService process owner. Preserve its separately managed installation and service-SID ACLs. A service-account rollback to LocalService also requires restoring the matching consumer; otherwise the current identity checks correctly reject it. The IIS module is managed separately from application release ZIPs, and its key stays outside Git/releases.

Use the recorded Windows service and IIS site names to stop/restart only this pilot. Logs should contain safe error/request identifiers, not passwords, cookies, signed URLs or environment-file contents. Check the service log, IIS status and API readiness when troubleshooting startup/proxy failures.

Before changing release selection, stop the service, preserve the previous release/service configuration, select the validated release, restart and check readiness/HTTPS access. Configuration remains in ProgramData. Rolling back application files does not undo database PCN saves or password changes and must remain compatible with the existing applied schema.

To retire the test, stop the PCN service/site, remove only its binding/firewall exception and pilot resources, and remove temporary certificate trust on clients. Do not delete Scn_DB or alter unrelated IIS sites.

Related: [application setup](../README.md), [migration plan](sql-server-migration.md), [API inventory](sql-server-api-checklist.md).
