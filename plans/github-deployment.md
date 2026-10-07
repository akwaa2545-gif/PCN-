# GitHub deployment to the internal Windows test host

Updated: 2026-10-07. The current live `pcn-test-9-1` uses the former Windows-authentication runtime. The user has chosen [SQL employee-code-only authentication](employee-code-authentication.md); replacement source, migration 003, verified administrator source-code mapping and reviewed IIS/release cutover are pending. Pause automatic polling for that cutover and resume only after its acceptance. This document does not claim the replacement is deployed.

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

## Employee-code cutover gate — pending

The replacement defaults to `AUTH_MODE=employee-code`; password mode is explicit maintenance only. It reads `[KEY_Code_DB].[dbo].[tblEmployee]` on the same configured SQL server, with no source writes, synchronization or bulk import. Selected employees still require active PCN accounts and explicit roles/departments. Migration 003 retires old AD mappings and revokes their sessions/tokens; a verified, explicit source-code link preserves the intended PCN user ID, roles and ownership.

Disable the polling task before selecting a replacement runtime. Separately preserve the database/configuration before-state, verify the administrator's intended source code, apply migration 003 and update **PCNTest only** to Anonymous Authentication enabled / Windows Authentication disabled. Archive/remove the retired Windows identity module/key setup and keep HTTPS, SQL secret isolation, loopback binding and ordinary server-owned client-IP rewrite. The replacement no longer carries the AD helper, Windows login route or identity-header proof.

Independently install the reviewed updated deployment consumer if its runtime allowlist changed; repository edits do not replace the protected host consumer. Validate the signed replacement archive, perform scoped cutover, verify real source-backed employee-code login/session/authorization/logout and exact service/listener identity, then record the actual release/results and resume polling. The initial source-code confirmation and live cutover have not completed. Restoring the old Windows release after migration 003 does not automatically restore retired account mappings; use the [reviewed recovery boundary](employee-code-authentication.md#acceptance-and-recovery).

## Acceptance evidence

### Current live former-auth runtime — pcn-test-9-1

[Actions 37562025155](https://github.com/akwaa2545-gif/PCN-/actions/runs/37562025155) succeeded and published signed [pcn-test-9-1](https://github.com/akwaa2545-gif/PCN-/releases/tag/pcn-test-9-1) from `9b00da23`. The host recorded deployment at observed server time `2026-10-07T02:41:51.5138466Z`; its clock differed from the workstation. It still uses the former Windows-authentication model, not the pending employee-code replacement.

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
