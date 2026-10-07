# Windows HTTPS deployment and employee-code cutover

Updated: 2026-10-07. The user selected [SQL employee-code-only login](employee-code-authentication.md), replacing the retired AD / Windows SSO design. Replacement source work is in progress. The live server cutover is **not complete**: migration 003, verified administrator source-code mapping, replacement release deployment and real GUI acceptance remain pending. The existing live release is `pcn-test-9-1` from `9b00da23`, still using its former Windows authentication configuration.

## Scope and retained components

The limited pilot runs on `THCHA-WEBHOST01`, Windows 10 Pro, at `https://172.30.77.137:8443`, with the separate IIS `PCNTest` site/application pool and `SupplierPCNTest` WinSW service. Node serves application routes/static files only through `127.0.0.1:3000`. Default Web Site's `*:80` binding was verified unchanged and responds HTTP 200.

The replacement data flow is:

```text
Browser employee code -> IIS HTTPS :8443 -> Node 127.0.0.1:3000
                                           | PCN users / sessions / roles -> Scn_DB
                                           | read-only employee lookup   -> KEY_Code_DB.dbo.tblEmployee
```

Both databases are on the configured server `svr120a`. The source table has 1,935 inspected records, unique non-null `EmpCode` text up to ten characters, names, job title and source department. It has no email/active flag. Source presence plus an explicit active PCN account/provider and manually granted PCN roles govern access. The source remains read-only; no bulk employee import or synchronization is performed.

The host has Node.js 26.10 and WinSW 2.12.0. The service currently runs as exact `NT AUTHORITY\NetworkService`, with its unique `NT SERVICE\SupplierPCNTest` SID enabled. Its previous process owner, parent, loopback listener and SQL readiness were verified. Changing the application auth mode does not require weakening these service-SID ACLs or giving the shared NetworkService account access to SQL secrets.

IIS on Windows 10 Professional permits ten concurrent requests, so this remains a limited pilot; wider use requires appropriate Windows Server capacity and maintenance. [Microsoft IIS request restrictions](https://learn.microsoft.com/en-us/iis/troubleshoot/request-restrictions).

## Release and configuration isolation

| Component | Retained deployment layout |
|---|---|
| Live former-auth release | `C:\SupplierPCN\releases\pcn-test-9-1`; replacement release not selected yet |
| Release directories | `C:\SupplierPCN\releases\pcn-test-<runNumber>-<runAttempt>` |
| WinSW service / logs | `C:\SupplierPCN\service` / `C:\SupplierPCN\logs` |
| Private backend environment | `C:\ProgramData\SupplierPCN\config\pcn.env`, selected by absolute `PCN_ENV_FILE` |
| Backend binding | `127.0.0.1:3000` only |
| Browser origin | Exactly `https://172.30.77.137:8443` |
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
PUBLIC_ORIGIN=https://172.30.77.137:8443
```

`employee-code` is the normal runtime default. Explicit `AUTH_MODE=password` is maintenance access for eligible unlinked legacy accounts. Obsolete AD/Windows settings and proxy secrets are removed from the replacement environment; their presence must not activate Windows mode. Normal employee-code sign-in requires neither a PCN password nor a Windows-authenticated browser.

## Reviewed cutover sequence — pending

1. Pause the `SupplierPCNTestDeployment` SYSTEM polling task for reviewed cutover; preserve its trust anchors, version records and current service/IIS configuration. Keep the live application running during preparation where possible.
2. Confirm the intended administrator's source `EmpCode` with the user. The former AD SamAccountName is not assumed to identify the same SQL-source employee. Preserve the intended PCN account ID, roles and ownership through an explicit verified link.
3. Check protected SQL/source connectivity and preserve an appropriate before-state. Apply reviewed migration 003 to `Scn_DB`, then verify readiness. Startup/deployment does not run DDL. The source `KEY_Code_DB` table must remain unchanged.
4. On **PCNTest only**, enable Anonymous Authentication and disable Windows Authentication. Archive/remove its old Windows identity module and separate key file/configuration. Retain HTTPS, certificate validation and other IIS sites.
5. Keep the ordinary loopback proxy and overwrite `X-PCN-Client-IP` with observed `REMOTE_ADDR` on every request, including forged caller values. Remove Windows identity forwarding; no AD header is authentication evidence for the replacement.
6. Set employee-code mode in the private backend environment, validate the reviewed signed replacement runtime and installed consumer, switch only the PCN service and verify exact Node/WinSW identity, loopback listener, schema/SQL/source behavior.
7. Verify real employee-code administrator login/session/authorization/logout through HTTPS, selected user creation/linking and source-outage denial; retain cookie/origin/CSRF protections and PCN signing/ownership permissions. Record the actual release and results before resuming the task.

These steps are not a declaration that the live cutover has occurred. The initial source-code confirmation and final deployment/GUI evidence are still pending.

## TLS and client setup retained

The HTTPS binding uses certificate thumbprint `B3691FE671FDCB46718B8E4AC7EA5B9EDEDF64FB`, expiring on 2027-01-04. Pinned-certificate IP validation passed. The approved client's Current User Root store contains the verified public certificate; normal operating-system TLS trust passed without a custom CA file or TLS bypass. The private key remains on the server.

The current user's HTTPS IP `172.30.77.137` was mapped to Local Intranet zone 1 during the former Windows-auth pilot. That mapping covers all HTTPS ports at this IP, with no HTTP/subnet/domain-wide mapping or credential-delegation/authentication-allowlist change. Employee-code login does not need that zone mapping for native SSO. Protected rollback metadata remains under `%LOCALAPPDATA%\SupplierPCN\deployment\sso-operations\backups\pcn-browser-before-*.json`; restore only the scoped client state if retiring it, retaining TLS trust required for the pilot.

The HTTP.sys binding is back at its verified original baseline with Disable HTTP2 Not Set and all other TLS fields unchanged. A former HTTP/1.1 trial did not resolve Edge `ERR_TOO_MANY_RETRIES` and was reverted. The former browser incident involved a VPN extension overriding native HTTP authentication challenges; its credentials are not recorded here. Those SSO diagnostics are [historical](employee-windows-authentication.md#historical-edge-incident), not setup requirements for the replacement. Successful browser GUI access after the new cutover remains to be observed.

Retire the pilot trust/binding when replacing the test with an approved CA-issued certificate. Remove only the installed pilot thumbprint from the client's Current User Root store when it is no longer needed, and never export a PFX/private key.

## Historical release evidence

[Actions 37562025155](https://github.com/akwaa2545-gif/PCN-/actions/runs/37562025155) succeeded and published signed [pcn-test-9-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-9-1) from `9b00da23`. The observed host deployment timestamp is `2026-10-07T02:41:51.5138466Z`; its clock differed from the workstation. It included the Retry authentication card visibility fix, verified by two extra assertions in the existing 59-check isolated browser run. This release has the former Windows authentication model, not the replacement code-only design.

Earlier `pcn-test-8-1` from `9f23256` passed 243 unit/API integration tests and 59 isolated browser checks in Actions 37559651975. Twelve real curl SSPI checks passed before/after that deployment. The installed consumer independently verified the exact release directory, NetworkService owner, WinSW parent and exclusive loopback listener; the SYSTEM polling task was enabled / Ready with result 0 at that final check. Those former SSO results do not verify employee-code login.

`pcn-test-6-1` from `359e1c43e39b30ec8ef1ebfbed30daa0bd54d939` passed 155 tests / 16 isolated browser checks in Actions 37426439232 and deployed on 2026-10-06 as LocalService. Its ZIP SHA-256 was `025e8eb72c849b09b97e5f68e7bdd2d3adc2de672136542bf6674af885935829`. SQL readiness, compact Mail service HTML and a backend recipient lookup with an inline photo passed; email delivery did not.

The first pipeline release `pcn-test-5-1` passed 134 tests / seven browser checks and deployed at `2026-10-06T04:13:57.8149751Z`. A repeat poll returned `already_current` without changing the service. Historical unauthenticated/source/proxy/origin checks passed in its password mode; they are not replacement acceptance evidence.

## Acceptance and recovery

Migration 001/002 and the original SQL-backed PCN pilot have verified historical readiness. Migration 003, the selected source-code administrator, normal employee-code login and a replacement release are pending. Keep automated tests, real HTTPS/API checks and actual GUI observation separate. No operational PCN save or notification delivery has been performed as part of the former authentication checks.

Before migration 002, a DPAPI-encrypted export of 22 PCN tables / 108 rows was decrypted and verified. The SQL login lacked native backup permission; this was not a native SQL backup and full restore was not tested. Maintain that limitation in the recovery record and arrange an appropriate protected before-state before migration 003.

Keep the task paused if cutover fails. Restore only a reviewed, schema-compatible release/configuration and the approved account access needed for recovery. Migration 003 retires Windows mappings and revokes sessions; switching old application files alone is insufficient to recreate former access. Do not undo operational PCN data or enable all source/retired users. Retain version high-water records and service-SID ACLs; inspect protected safe logs/readiness without exposing secrets.

To retire the test, stop only PCN resources and remove their binding/firewall exception and scoped client trust as appropriate. Do not delete either database or change unrelated IIS sites.

Related: [employee-code design](employee-code-authentication.md), [GitHub deployment](github-deployment.md), [API inventory](sql-server-api-checklist.md), [application setup](../README.md).
