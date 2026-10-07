# Retired AD / Windows authentication pilot record

Updated: 2026-10-07. **Historical record only.** The user replaced this design with [SQL employee-code authentication](employee-code-authentication.md). Do not use the former AD/IIS setup as current rollout guidance. The live `pcn-test-9-1` Windows runtime has not yet been cut over; replacement migration 003, verified administrator source-code mapping and live release acceptance remain pending.

## Former identity model

The pilot used AD SamAccountName as Empcode, with an administrator-selected account mapping stored in SQL as AD object GUID, SID and employee code. IIS authenticated a native Windows user and Node checked the trusted loopback headers, active AD record and explicit SQL account. Domain membership alone did not register users. Typed employee names/codes did not establish identity in that former model.

New AD accounts had no PCN password. Explicit account linking preserved PCN user IDs, role grants and ownership, rotated security stamps and revoked sessions; retained legacy hashes were unusable after linking. Duplicate GUID, SID or employee code was rejected rather than merged. Existing signing/ownership and mail-recipient permissions were unchanged.

The former Windows login route was `POST /api/auth/windows`, and AD create/link requests used a selected `directoryId`. Those Windows/AD runtime paths are being removed. The replacement uses source `EmpCode` and explicit provider state; it does not convert old SamAccountName mappings automatically.

## Verified pilot evidence — 2026-10-07

- DNS domain `KEMET.COM` and NetBIOS `KEMET` were verified.
- Migration 002 was applied to `Scn_DB` at `2026-10-07T01:31:43.572Z`. Both migrations passed readiness, preserving the original two SQL users. Only selected SamAccountName `2172172512501` was added as administrator / PCN department `it`; no bulk AD import occurred.
- The SQL login lacked `BACKUP DATABASE` permission. Before migration 002, a DPAPI-encrypted logical export of 22 PCN tables / 108 rows was created and its decryption verified. This was not a native SQL backup, and a full restore was not tested.
- `SupplierPCNTest` changed from LocalService to exact `NT AUTHORITY\NetworkService`, using machine credentials for read-only AD lookup. Node owner, WinSW parent, exclusive loopback listener and AD lookup passed. The unique service-SID ACLs were preserved; shared NetworkService processes were not granted SQL/environment-file access.
- PCNTest used Windows Authentication enabled, Anonymous Authentication disabled and SSL required. Required IIS features were enabled without reboot; Default Web Site's `*:80` binding remained unchanged.
- The separately managed C# identity module cleared caller headers at BeginRequest and generated trusted headers at PostAuthenticateRequest, validating TLS, the native Windows identity, `LOGON_USER`, domain and client address. It stripped the incoming Authorization token before forwarding. A pool-readable private key file was separate from the backend's service-readable SQL/environment file.
- The module compiled, passed 18 boundary cases and received C# / security review. Main `9f23256` CI passed 243 unit/API integration tests and 59 isolated browser checks.
- Twelve real-client curl SSPI checks passed before and after `pcn-test-8-1`: Windows configuration, selected administrator login/session, master data, admin users, own AD lookup, forged-header replacement, password endpoint denial, CSRF logout denial, valid logout and logged-out session state. These results were separate from the isolated browser tests.
- Signed `pcn-test-9-1` from `9b00da23` was deployed at observed server time `2026-10-07T02:41:51.5138466Z`, after Actions 37562025155 succeeded. It included the Retry authentication card visibility fix.

Actual successful browser GUI sign-in, operational PCN saves, pilot account linking, other-user denial cases, signing/ownership behavior and email delivery were not established by those live checks.

## Historical Edge incident

Edge reported `ERR_TOO_MANY_RETRIES`, with native IIS `401.1` / `C000006D` failures observed. Approved client setup imported the verified public certificate into the current user's Root store and mapped only the exact HTTPS IP to Local Intranet zone 1. The zone mapping covered all HTTPS ports at that IP, with no HTTP/subnet/domain-wide mapping, authentication allowlist, credential-delegation or TLS-bypass change. Operating-system-trust SSPI returned HTTP 200.

A scoped HTTP/1.1 trial on only HTTP.sys `172.30.77.137:8443` preserved the certificate/application ID and all other TLS fields, but the user observed the same Edge error. It was reverted; Disable HTTP2 returned to Not Set and the binding baseline was verified unchanged. This did not establish HTTP/2 as the cause.

Edge ran under the expected Windows account; an inspected 30-minute server Security event 4625 window contained no matching employee-account failures while failure auditing was enabled. Browser inspection then found a VPN extension returning its configured credentials for all HTTP authentication challenges without a proxy-only guard; a failed account matched that extension configuration. Actual credentials/tokens and extension user data are excluded from this record. A disable/restart/retry test and independent security review were pending when the user replaced the authentication design. The record does not claim that GUI access was resolved.

## Retirement boundary

The replacement has no AD employee helper, Windows identity headers/proxy key, IIS identity module or Windows sign-in route. Migration 003 marks old mappings `retired-windows`, rotates stamps and revokes their sessions/tokens; an administrator must explicitly link a verified SQL-source EmpCode while preserving the intended PCN account ownership. Current setup and cutover guidance belongs in [employee-code-authentication.md](employee-code-authentication.md), not this retired record.

Related: [Windows deployment status](windows-test-deployment.md), [GitHub pipeline](github-deployment.md).
