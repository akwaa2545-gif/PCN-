# Windows HTTPS test deployment

Updated: 2026-10-06. Current signed release `pcn-test-6-1` is deployed from main commit `359e1c43e39b30ec8ef1ebfbed30daa0bd54d939`. CI passed 155 tests/16 isolated browser checks and the dependency audit gate. Exact process identity, loopback listener and pinned-certificate HTTPS SQL readiness passed independently. Authenticated client health/directory UI, observed browser trust and email delivery remain unverified.

## Scope and components

The authorized pilot serves the SQL-backed PCN app on `THCHA-WEBHOST01`, Windows 10 Pro, at `https://172.30.77.137:8443`. It uses a separate IIS `PCNTest` site and application pool so the pilot configuration is isolated from existing IIS sites. Node handles application routes/static assets through the API server; IIS terminates HTTPS and proxies to loopback port 3000.

```text
Test browser -> IIS PCNTest HTTPS :8443 -> Node 127.0.0.1:3000 -> svr120a / Scn_DB
                                                   |
                                              WinSW service
```

This is a limited pilot. IIS on Windows 10 Professional permits ten concurrent requests; excess requests queue. That limit is about active requests, not a fixed number of signed-in users. Wider use should move to Windows Server with appropriate capacity and supported operating-system maintenance. [Microsoft IIS request restrictions](https://learn.microsoft.com/en-us/iis/troubleshoot/request-restrictions)

The host has Node.js 26.10 installed. A real Node 26 service process running as LocalService, its loopback listener and SQL-backed readiness were observed. These startup checks do not replace the full host compatibility/test suite. The service wrapper is pinned to stable WinSW 2.12.0; upstream identifies 2.x as the stable line. [WinSW project](https://github.com/winsw/winsw), [v2.12.0 release](https://github.com/winsw/winsw/releases/tag/v2.12.0)

The pilot connects to the existing `Scn_DB`. Saves and password changes persist there; no separate sandbox database is implied. Deployment does not run migrations, imports, bootstrap or initial-account smoke scripts. Existing data/accounts are reused, and recipient routing is maintained separately. The authorized mail/directory endpoints are configured privately outside releases. Deployment checks made no SQL mutations or test mail calls.

## Release, configuration and service isolation

| Component | Required deployment layout |
|---|---|
| Current pilot release | `C:\SupplierPCN\releases\pcn-test-6-1` |
| Future pipeline release files | `C:\SupplierPCN\releases\pcn-test-<runNumber>-<runAttempt>`; record the selected directory for each rollout |
| WinSW executable/XML and service artifacts | `C:\SupplierPCN\service` |
| Service logs | `C:\SupplierPCN\logs` |
| Private environment file | `C:\ProgramData\SupplierPCN\config\pcn.env` |
| Service environment pointer | `PCN_ENV_FILE` set to that absolute environment-file path |
| Backend listener | Loopback only, port 3000; no public inbound exposure |
| Public origin | Exactly `https://172.30.77.137:8443` |
| Process environment | `NODE_ENV=production` for Secure session cookies |
| Windows service identity | `SupplierPCNTest`, LocalService with its unique service SID enabled for ACLs |
| IIS identity | `PCNTest` application pool for the `PCNTest` site; no database-secret access |

Keep SQL credentials and signed integration URLs outside versioned releases. Do not put them in WinSW XML, IIS web.config, build output, documentation, source control or logs. Grant `NT SERVICE\SupplierPCNTest` read access to the private environment file; do not grant all `LOCAL SERVICE` processes access. Grant that service SID read/execute on its selected release and read/write on its logs. Administrator/SYSTEM maintenance access is separate.

The nonsecret pilot configuration is:

```text
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
NODE_ENV=production
PUBLIC_ORIGIN=https://172.30.77.137:8443
```

The service supplies `PCN_ENV_FILE=C:\ProgramData\SupplierPCN\config\pcn.env`; database credentials are maintained privately in that file.

`PCN_ENV_FILE` must be absolute and loaded by the application before configuration validation. Relative working-directory `.env` files must not override the deployment's external configuration. The service should fail startup when its configuration is missing/unreadable rather than silently use a developer credential profile. Confirm these behaviors before acceptance.

Node's database configuration remains server-side. Use the existing SQL connection profile privately; never print the environment file to verify it. The IIS site must proxy application requests, rather than statically publishing a release directory containing source/configuration.

## Proxy and client address handling

IIS must overwrite `X-PCN-Client-IP` with its observed client address on every proxied request. A caller-supplied value must not be forwarded unchanged. The Node app trusts this custom header only when the direct socket peer is loopback; untrusted peers must use their socket address. Do not infer authority from arbitrary `X-Forwarded-For` values.

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
5. Create the separate IIS site/application pool, configure HTTPS :8443 with the selected certificate, and proxy to Node. Overwrite the custom client-IP header.
6. Verify client access, certificate trust, auth/CSRF and deep links. Recheck other sites after pilot changes.
7. Record the actual release/service/binding names and completed acceptance evidence below. Only then report the pilot URL as working.

## Verified deployment pipeline

The user requested an automated pipeline. Its [separate runbook](github-deployment.md) describes GitHub-hosted Windows CI tests, an Ed25519-signed public prerelease containing only production runtime files, and the `SupplierPCNTestDeployment` SYSTEM task with highest privileges, scheduled every ten minutes and at startup. This design uses neither an internet-facing deployment listener nor a self-hosted GitHub runner. GitHub holds the release-signing secret; SQL credentials remain on the deployment host.

[Actions run 37426439232](https://github.com/akwaa2545-gif/PCN-/actions/runs/37426439232) passed all steps, including 155 tests, 16 isolated browser checks and the high/critical dependency audit gate. It published signed [pcn-test-6-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-6-1) from main commit `359e1c43e39b30ec8ef1ebfbed30daa0bd54d939`. The host recorded deployment at `2026-10-06T07:06:27.3234975Z`; last-deployed state matches that release/commit. The task is Ready with LastTaskResult 0 and the service is Running.

The current release passed pinned-certificate HTTPS `/api/ready` with SQL readiness and serves the compact Mail service HTML. A host-side backend directory lookup returned one matching profile with an inline photo; mail configuration passes local validation. Private directory configuration was replaced atomically under the deployment mutex with a protected backup and original ACLs, preserving existing mail/SQL values after a zero queued-job check. That update invoked no flow/restart/SQL mutation; the subsequent deployment loaded the configuration. No authenticated client health UI or mail delivery was tested.

An independent check confirmed `C:\SupplierPCN\releases\pcn-test-6-1\server.js` runs as LocalService with its WinSW service parent, exclusively on `127.0.0.1:3000`. The release ZIP SHA-256 is `025e8eb72c849b09b97e5f68e7bdd2d3adc2de672136542bf6674af885935829`.

First-pipeline history: `pcn-test-5-1` passed 134 tests/seven browser checks and deployed at `2026-10-06T04:13:57.8149751Z`. Its repeated poll logged `already_current` without changing the service PID/state. Initial HTTPS login/session, unauthenticated/source denials, overwritten client-IP header and foreign-origin checks passed; those historical checks did not perform authenticated pilot login or database writes.

## Acceptance record

The following table records only supplied deployment evidence. Local browser smoke flows passed against isolated test adapters; they do not prove authenticated login or PCN saving on this HTTPS pilot.

| Check | Required evidence | Status |
|---|---|---|
| Host and listener | THCHA-WEBHOST01; IIS PCNTest HTTPS :8443; Node 127.0.0.1:3000 only; workstation cannot connect to :3000 | Verified |
| Runtime compatibility | Windows Node 26 CI: 155 tests/16 isolated browser checks; deployed SQL readiness | Verified CI/startup; tests use isolated adapters |
| Service identity and ACLs | SupplierPCNTest Running; exact pcn-test-6-1 server.js command, LocalService owner/WinSW parent; service-SID configuration/release ACLs | Verified after cutover |
| External configuration | Absolute PCN_ENV_FILE external to release, protected service-specific configuration | Installed; missing-file startup behavior verified by focused runtime-env tests |
| Health/readiness | HTTPS health/readiness return 200 through IIS with certificate/IP verification | Verified |
| Certificate | Binding thumbprint/expiry and pinned-certificate TLS IP check | TLS verified; user reports client trust done, actual browser trust not observed |
| Public login/session | Login page 200; anonymous session endpoint 200 | Verified; actual authenticated login/logout/cookies pending |
| Unauthenticated API/static boundaries | PCNs return JSON 401; environment/source/src paths return 404 | Verified |
| Origin and proxy header | Foreign Origin rejected 403; duplicate forged X-PCN-Client-IP overwritten by IIS | Verified; remaining authenticated CSRF/throttling checks pending |
| PCN navigation | Admin, create, saved PCN deep links and browser refresh through IIS | Pending |
| Data behavior | Existing Scn_DB reused; no migration/import/bootstrap or SQL writes by deployment checks | SQL readiness verified; no pilot save/login claimed |
| Isolation | Existing Default Web Site `*:80` binding unchanged | Verified binding; broader site regression pending |
| Restart | Service restart returns Running/Automatic LocalService with loopback listener and SQL readiness | Verified |
| Polling task | SupplierPCNTestDeployment SYSTEM/Highest, every ten minutes plus startup; Ready/result 0, deployed state matches pcn-test-6-1 | Verified current deployment; prior 5-1 no-op poll retained as history |
| Pipeline | Actions 37426439232 passed; signed pcn-test-6-1 installed from commit 359e1c43e39b30ec8ef1ebfbed30daa0bd54d939 | Verified |
| Mail/directory configuration | Private endpoints loaded on release restart; valid local mail configuration and one matching inline-photo profile from host backend lookup | Verified backend configuration/lookup; no test email or real client UI claim |

Current Windows CI passed 155 tests and 16 isolated browser checks. Local coverage was 95.03% lines, 88.27% branches and 94.70% functions. Neither measures a live authenticated client session or email delivery; browser adapters isolate test state from Scn_DB.

For save testing, record the test PCN identifiers and distinguish test records from operational records because writes persist in the existing database.

## Operations and rollback

Use the recorded Windows service and IIS site names to stop/restart only this pilot. Logs should contain safe error/request identifiers, not passwords, cookies, signed URLs or environment-file contents. Check the service log, IIS status and API readiness when troubleshooting startup/proxy failures.

Before changing release selection, stop the service, preserve the previous release/service configuration, select the validated release, restart and check readiness/HTTPS access. Configuration remains in ProgramData. Rolling back application files does not undo database PCN saves or password changes and must remain compatible with the existing applied schema.

To retire the test, stop the PCN service/site, remove only its binding/firewall exception and pilot resources, and remove temporary certificate trust on clients. Do not delete Scn_DB or alter unrelated IIS sites.

Related: [application setup](../README.md), [migration plan](sql-server-migration.md), [API inventory](sql-server-api-checklist.md).
