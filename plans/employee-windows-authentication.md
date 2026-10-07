# Employee provisioning and Windows authentication

Updated: 2026-10-07. Sources: `src/authConfiguration.js`, `src/windowsIdentity.js`, `src/windowsDirectoryService.js`, `src/authService.js`, `src/apiRoutes.js`, `scripts/ad-directory.ps1`, `scripts/iis-windows-auth/PcnWindowsIdentityModule.cs`, migration 002 and the live pilot checks below. Windows sign-in is enabled on PCNTest and verified from a real domain client. Only selected employees are provisioned; this rollout did not import all AD users.

## Identity and permissions

**Empcode is the AD SamAccountName.** Administrators select an active employee from AD, then assign PCN roles and a PCN department in Create User. The backend re-queries the selected object GUID; typed names, email addresses and browser-supplied profile fields cannot establish identity. The SQL account stores the AD object GUID and SID as well as employee code. Windows sign-in must match all three against an active AD employee and an active, explicitly provisioned SQL account. It does not auto-register domain users.

Roles remain `admin`, `reviewer`, `supplier`, `gsc`, `productionengineering`, `qa`, `tapbu`. Department choices are `gscTet`, `prodEngTet`, `qaTet`, `gscTapbu`, `qaTapbu`, `it`, `other`; an AD department is a search/profile hint, not a PCN permission grant. Existing review/signing permissions and supplier ownership rules are unchanged.

New AD accounts have no PCN password or forced-password-change requirement. Linking an existing account preserves its SQL user ID, ownership, role grants and legacy password hash, and revokes prior sessions. The retained hash is unusable: linked accounts cannot use PCN password login or password change in any auth mode. Linking an existing administrator is blocked in password mode: first create a **separate AD-mapped administrator** for rollout. Do not convert the working password administrator before Windows sign-in has been verified.

The rollout administrator must use a different AD identity from any existing account intended for linking. Duplicate GUID, SID or employee code returns 409; accounts are not merged. To retain an old administrator's PCN ownership, have another approved AD administrator perform the rollout, enable Windows sign-in, then link the old account to its own unused AD identity.

## Prerequisites and schema gate

Apply [002_employee_identity.sql](../sql/migrations/002_employee_identity.sql) using the reviewed migration runner (`npm run db:migrate`) before starting this source version locally or selecting a release containing it. First check the intended database privately with `npm run db:check`; after migration, check readiness again. Migration 002 adds nullable identity/profile columns and filtered unique employee-code/GUID/SID indexes to `pcn.Users`, and permits a null PasswordHash for AD accounts. It does not backfill mappings or change existing user IDs/roles. Startup checks schema readiness and runs no DDL. Production runtime ZIPs do not contain migrations, so the DBA must apply the versioned migration from reviewed source before release cutover.

Migration 002 was applied to `Scn_DB` at `2026-10-07T01:31:43.572Z`; readiness verified both migrations. The original two SQL users were preserved. The SQL login lacked `BACKUP DATABASE` permission. Before applying the additive migration, an encrypted DPAPI logical export of 22 PCN tables / 108 rows was created and its decryption verified. This is not a native SQL backup, and a full database restore was not tested.

Before publishing/selecting this feature release, install the reviewed updated `scripts/deploy-pcn-release.ps1` consumer through the existing protected maintenance procedure. Its archive allowlist admits `scripts/ad-directory.ps1` and `admin-users.js`; an older installed consumer may reject the new archive. Updating repository source alone does not update the protected installed consumer. The protected live consumer was updated for this rollout and now verifies the exact NetworkService process identity.

The Windows-only helper performs bounded, read-only LDAP searches using .NET DirectoryServices under the **Node service's identity**. It accepts no AD password and writes nothing to AD. AD employee search is separate from the Power Automate directory endpoint used for mail recipients. Confirm DNS/domain-controller reachability and that the chosen service identity can read the required enabled-user attributes.

The pilot service now runs as `NT AUTHORITY\NetworkService`, using the domain-joined host's machine credentials for read-only AD access. Its exact Node process owner and successful AD lookup under that identity were verified. The unique `NT SERVICE\SupplierPCNTest` ACLs were retained; the shared NetworkService account has no read grant on the SQL/environment file. The former LocalService deployment is historical evidence only; its SQL connectivity did not establish AD access.

`AD_DOMAIN=KEMET.COM` is the verified DNS directory domain and `WINDOWS_AUTH_DOMAIN=KEMET` is its verified NetBIOS name. For another environment, verify these values rather than assuming them. From an authorized Windows administration session with the AD PowerShell module, use this read-only check:

```powershell
Get-ADDomain -Identity 'KEMET.COM' | Select-Object DNSRoot, NetBIOSName
```

Use the verified NetBIOSName for `WINDOWS_AUTH_DOMAIN`; the application expects IIS identity in `DOMAIN\SamAccountName` form. The runtime LDAP helper itself does not require the AD PowerShell module. [Microsoft Get-ADDomain documentation](https://learn.microsoft.com/en-us/powershell/module/activedirectory/get-addomain?view=windowsserver2022-ps).

## Staged configuration and IIS cutover

Keep configuration in the protected external `PCN_ENV_FILE`; preserve SQL/mail settings and existing ACLs. The staging template contains no secret:

```dotenv
AUTH_MODE=password
AD_DOMAIN=KEMET.COM
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
NODE_ENV=production
PUBLIC_ORIGIN=https://172.30.77.137:8443
```

1. Apply migration 002 and verify the service identity's AD reads. Keep password mode while the existing administrator selects AD employees and creates the separate AD-mapped administrator with role/department. No PCN password is entered for those accounts; they cannot sign in until Windows mode is enabled.
2. Preserve a private backup of the PCN site's IIS settings and service configuration. Install the IIS Windows Authentication feature if needed, then configure **PCNTest only** with Windows Authentication enabled, Anonymous Authentication disabled and SSL required. Leave other sites unchanged. [Microsoft IIS Windows Authentication documentation](https://learn.microsoft.com/en-us/iis/configuration/system.webServer/security/authentication/windowsAuthentication/).
3. Keep the backend bound exclusively to loopback. Install the reviewed `PcnWindowsIdentityModule` only on PCNTest, with its application pool using CLR v4 and Integrated pipeline mode. URL Rewrite runs before Windows authentication, so it cannot establish the authenticated identity. The module clears caller-supplied identity headers at BeginRequest, then replaces the three headers below at PostAuthenticateRequest. It requires TLS, IIS's native authenticated Windows logon token, matching `LOGON_USER`, the configured domain and a valid server-observed client IP. Empty or invalid identity fails closed. The module also removes the incoming Windows Authorization token before ARR forwards to Node.
4. Generate 32 random bytes on the server and encode them as a 44-character base64 proxy key. Store the same value in protected backend `WINDOWS_AUTH_PROXY_KEY` and the separate IIS module key file. Never put it in source, a release, browser code, logs or this document. Grant the PCN application pool read access only to its key file; it receives **no** access to the backend SQL/environment file. Preserve administrator/SYSTEM maintenance access and the backend service-specific ACLs.
5. Set `AUTH_MODE=windows` and `WINDOWS_AUTH_DOMAIN` to the verified NetBIOS name in the external backend configuration. Restart only the PCN service after its IIS/AD/schema prerequisites are ready, then verify sign-in using the separate provisioned AD administrator.

| IIS request header / server variable | Server-owned value |
|---|---|
| X-PCN-Client-IP / HTTP_X_PCN_CLIENT_IP | `{REMOTE_ADDR}` |
| X-PCN-Windows-User / HTTP_X_PCN_WINDOWS_USER | Native Windows logon identity, verified against `LOGON_USER` after authentication |
| X-PCN-Windows-Auth-Key / HTTP_X_PCN_WINDOWS_AUTH_KEY | Private proxy key; no literal value in committed templates |

The backend accepts Windows identity only from a loopback socket with exactly one user/key header, the matching key and configured domain. Cookies/CSRF/origin checks remain required. Protected data and session requests revalidate AD identity and SQL session/stamp mapping; a cookie alone is insufficient. Logout revokes the SQL session and clears its cookie without requiring AD availability, while enforcing same-origin and the SQL session's CSRF token. Password sign-in/change endpoints are disabled in Windows mode. Domain credentials are handled by Windows/IIS, never submitted to the PCN API.

AD outage makes session validation fail closed with 503. An invalid/expired session returns the browser to Windows continuation; it does not offer a PCN-password fallback. Helper input uses UTF-8 so employee searches preserve Unicode.

## API contract

Normal success/error envelopes and existing admin authorization/CSRF rules apply.

| Endpoint | Implemented behavior |
|---|---|
| GET /api/auth/config | Public `{mode,employeeProvisioningConfigured}` only; no domains, keys or directory infrastructure |
| GET /api/admin/employees?query=... | Admin active AD search, trimmed 2–100 characters, at most 20 profiles; data array of directoryId/employeeCode/displayName/email/adDepartment, no SID |
| POST /api/admin/users | When AD is configured, accepts only `{directoryId,roles,department}`; server re-queries AD and creates a passwordless SQL mapping. Legacy password creation remains available only without AD configuration in password mode |
| POST /api/admin/users/:uuid/directory | Admin `{directoryId}` only; link selected active AD employee to the existing user, preserving ID/roles and revoking sessions; password-mode admin linking is blocked |
| POST /api/auth/windows | Windows mode only; same-origin empty JSON object, trusted IIS headers, mapped active AD/SQL identity, then normal session cookie/CSRF token |

The login page reads auth/config and offers Windows continuation in Windows mode. Directory failures return safe errors rather than AD details. Employee provisioning does not modify recipient mappings or the separate `GET /api/admin/directory-users` integration.

## Acceptance and rollback

Live evidence recorded on 2026-10-07:

- Migration 002 and SQL readiness passed; the original two users were preserved. Only SamAccountName `2172172512501` was added as a mapped PCN administrator in department `it`.
- DNS `KEMET.COM`, NetBIOS `KEMET`, the exact NetworkService owner and read-only AD lookup under the service identity passed.
- PCNTest has Windows Authentication enabled, Anonymous Authentication disabled and SSL required. The required IIS features were enabled without a reboot. Default Web Site's `*:80` binding remains unchanged.
- Twelve checks from a real Windows client using curl SSPI and the pinned TLS certificate passed before and after the automatic `pcn-test-8-1` deployment: Windows configuration, the provisioned administrator login, authenticated session, master data, admin users, own AD lookup, forged identity-header replacement, password endpoint denial, missing-CSRF logout denial, valid logout and the logged-out session state.
- The IIS module compiled and passed 18 boundary cases with C# and security review. CI for main `9f23256` passed 243 unit/API integration tests and 59 isolated browser checks. These adapters do not establish live browser GUI behavior.

Actual browser GUI sign-in, pilot account linking, unprovisioned/disabled-user denial and signing/ownership behavior remain to be observed on the live pilot. Their isolated automated coverage is not a claim that those production data flows were exercised. No test notification email or operational PCN save was sent by the SSO acceptance checks.

Keep prior password-mode configuration and its **unlinked** administrator for rollback. If cutover fails, restore the PCN site's prior authentication/proxy/module settings and `AUTH_MODE=password`, select a schema-compatible release and restart only PCN. Keep the protected deployment consumer and service-account choice consistent: the current consumer requires NetworkService, so reverting to LocalService also requires restoring its corresponding consumer. Returning to password mode invalidates Windows-account sessions and does not automatically unlink accounts or make their retained legacy password hashes usable; linked accounts cannot use password login/change. Retain the additive migration and preserve data rather than attempting automatic schema rollback.

Related: [API inventory](sql-server-api-checklist.md), [table mapping](sql-server-table-mapping.md), [Windows pilot runbook](windows-test-deployment.md).
