# SQL Server source-to-table mapping

Updated: 2026-10-07. Target: existing `svr120a / Scn_DB`. Sources: migrations 001/002/003 and repository/hydration/auth/document/routing modules. Names use the `pcn` schema. Department/action routing-v2 is deployed in pcn-test-8-1; it adds no DDL. Live routing saves and email delivery were not exercised by the Windows sign-in checks.

The target is SQL Server 2014 (version 12, compatibility 120). JSON payloads are Unicode text parsed/validated in Node; the migration avoids unavailable SQL JSON functions. Migration 001 is applied, with 21 application tables plus migration history, master-data version 1 and a hashed, forced-change `itadmin` account. Seven routing groups were initialized empty. Live SQL verification writes were rolled back. Existing Firebase records have not been imported.

Employee source `KEY_Code_DB.dbo.tblEmployee` is read-only and its 1,935 records are not imported. PCN owns `pcn.Users` (employee mapping, IdentityProvider, DepartmentKey, IsActive), `pcn.Roles` and `pcn.UserRoles` in `Scn_DB`. Migration 003 was applied at `2026-10-07T03:35:30.942Z`, adding provider separation and retiring old Windows mappings/session state; 001/002 were unchanged. The prior three accounts were preserved and separate verified `2205529` Administrator / IT account added. Only explicitly provisioned active employee-code accounts can sign in; source department hints never grant permissions. See [current acceptance](employee-code-authentication.md#acceptance--2026-10-07).
## PCN aggregate

Local document-control migration 005 adds `pcn.PcnRevisions` with immutable save number, content revision, actor, timestamp, status, field differences and complete snapshot. Server-owned `documentControl` digest/signature bindings use existing `LegacyExtrasJson`; attachment metadata adds requirement category, uploader/time, content revision and soft-removal timestamp. File removal retains bytes. Migration 005 was applied to svr120a / Scn_DB on 2026-10-09; see [document control](document-control.md).

SQL normalizes parent fields and ordered child tables while retaining complete nested payloads as `nvarchar(max)`. This saves PCN data in SQL even though some evolving form fields retain JSON representation.

| Source / field | Implemented destination | Preservation rule |
|---|---|---|
| pcnRequests[id], converted Firestore PCN document | PcnRequests | Preserve public PCN-YYYY-NNNN code; internal bigint PcnId |
| id | PcnCode nvarchar(32), unique | API canonical code; browser normalizes legacy aliases |
| ownerUserId | OwnerUserId uniqueidentifier, Users FK | New record owner is authenticated user; unresolved imports are not supplier-visible |
| masterDataVersionId | MasterDataVersionId int, master FK | New records reference active seeded definition |
| status/changeForm/riskLevel | Status nvarchar(40), ChangeForm nvarchar(40), RiskLevel nvarchar(10) | Domain validation in application |
| selectedChange | SelectedChange nvarchar(max) | Full edited heading |
| supplierName/manufacturerName/materialName | SupplierName/ManufacturerName/MaterialName nvarchar(max) | Text snapshots, not ownership identities |
| desiredStart | DesiredStartText nvarchar(max) | Date/lot free text |
| sampleSubmitted | SampleSubmitted nvarchar(20) | Existing yes/no/pending shape |
| currentCondition/newCondition/reason | CurrentCondition/NewCondition/Reason nvarchar(max) | Full text preserved |
| identification/sampleLocation | Identification/SampleLocation nvarchar(max) | Full text preserved |
| priceLevel | PriceLevel nvarchar(20) | Existing price option |
| sourceTemplate/changeType | SourceTemplate/ChangeType nvarchar(max) | Historical template/change snapshots |
| createdAt/updatedAt/submittedAt | CreatedAt/UpdatedAt/SubmittedAt datetime2(3), nullable | Machine timestamps hydrate as UTC ISO strings |
| sampleSubmittedDate and other non-column fields | LegacyExtrasJson nvarchar(max) | Preserve unknown fields; local v2 stores server-owned mailRoutingPolicyVersion/mailRoutingState here, with no new column |
| Presence and null shape | PresentFieldsJson nvarchar(max) | Preserve omitted vs explicit-null nested/array fields |
| version | RowVersion rowversion | Hydrated 16-character hex concurrency token, not a date |
| Deletion state | DeletedAt datetime2(3), DeletedBy nvarchar(256) | Soft delete; parent/children/history remain |

Historical scalar text uses nvarchar(max) to avoid fixed-length import truncation. Machine dates still require valid conversion; do not treat business date/lot expressions as machine dates.

## Ordered children and internal review

Each aggregate child table has `(PcnId, SortOrder)` as its primary key and a parent FK. PayloadJson retains the complete original child item, including arbitrary original IDs and additional fields. Typed columns support access/reporting; hydration uses the payload to preserve exact structure/order.

| Source | Table | Typed columns besides key / retained content |
|---|---|---|
| changeRows[] | PcnChangeRows | Risk nvarchar(10); OptionText/Text/CurrentCondition/NewCondition nvarchar(max); PayloadJson |
| documents[] | PcnDocuments | Name nvarchar(max), Required/Uploaded nullable bit; PayloadJson. These are requirement/history flags, not file content |
| route[] | PcnRouteSteps | OwnerSnapshot nvarchar(max); PayloadJson preserves historical route |
| comments[] | PcnComments | LegacyId nvarchar(128), Role nvarchar(80), Comment nvarchar(max), CreatedAt datetime2(3), PayloadJson |
| approvals[] | PcnApprovals | LegacyId/Role, Decision nvarchar(40), Comment/CreatedAt, PayloadJson |
| internalReview | PcnInternalReviews | One row per PcnId; complete ReviewJson nvarchar(max) |

The full internal review preserves these observed variants:

- materialCodeDescription and pcnCode.
- supplierSignoff.{approved,checked,prepared}.{checked,date}.
- docs flags plus supplierDocumentNote/otherRequirementNote.
- decision.{agreed,agreedAfterQualification,rejected,qualificationDue,rejectReason}.
- signoff.{gscTet,prodEngTet,qaTet}.{approved,checked,prepared,date,comment}.
- tapbu.{need,noNeed,comment} and tapbu.{gsc,qa} signoff objects.
- qateFinal.{approve,reject,qod206Number,completedDate} and final signoff flags with separate approvedDate/checkedDate/preparedDate.

Review dates stay text. Checkbox snapshots do not prove a historical approver identity. New edits have server-attributed audit entries and department permissions; a separate immutable signoff-event table is future work.

## Authentication and supporting tables

| Table | Actual key and important columns | Runtime use |
|---|---|---|
| Users | Id uniqueidentifier; employee code/normalized code, provider, department, display name; active/stamp/session fields; nullable legacy password/email columns | Employee-provider accounts have no password and explicit source-code mapping; old password accounts remain maintenance-only; old AD mappings are retired |
| Roles | Id int identity; Name nvarchar(40) unique | admin, reviewer, supplier, gsc, productionengineering, qa, tapbu |
| UserRoles | UserId uniqueidentifier + RoleId int composite PK/FKs | Role membership |
| Sessions | Id uniqueidentifier; UserId; TokenHash char(64) unique; CsrfToken char(64); SecurityStamp; ExpiresAt/CreatedAt/RevokedAt | Opaque cookie hash, expiry/revocation/account stamp checks; 8-hour/30-day durations |
| AccountTokens | Id uniqueidentifier; UserId; TokenHash char(64); Purpose nvarchar(40); stamp/target-email/expiry/used fields | Reserved for future recovery/activation; no recovery endpoints yet |
| MasterDataVersions | Id int identity; DefinitionHash char(64) unique; DefinitionJson nvarchar(max); IsActive/CreatedAt | Seed formDefinitions/commonDocuments/workflowBase/statusDefinitions/adminItems; unique active version |
| PcnCounters | Year int PK; LastSequence int | Serializable code allocation in create transaction; overflow guarded |
| AuditLogs | Id nvarchar(128) PK; PcnCode nvarchar(128); Action nvarchar(80); Actor nvarchar(256); MetadataJson; CreatedAt; optional SourceJson | Supports PCNs, deleted records and notification-settings targets; no mandatory parent FK |
| NotificationSettings | Singleton Id=1; SettingsJson nvarchar(max); UpdatedAt | Local v2 stores schemaVersion=2, 16 groups and preserved seven legacyGroups in JSON; Node-computed SHA-256 version, no new column; no URL exposure |
| NotificationGroups | GroupKey nvarchar(80) PK; SortOrder/Label/Emails | Current-group mirror: legacy seven or v2 sixteen after a v2 settings save; legacyGroups stay in SettingsJson |
| NotificationRecipients | GroupKey + SortOrder composite PK; Email nvarchar(320); ProfileJson | Ordered optional recipient profiles |
| MigrationSourceRecords | SourceKey nvarchar(256) PK; SourceHash char(64); SourceJson; ImportedAt | Idempotent import evidence; private source data requires restricted access |
| NotificationJobs | Id uniqueidentifier; EventKey nvarchar(200) unique; PCN code/version/group/action; recipient/payload; status/attempt/lease/claim/timestamps/error | Local policy 2 atomically inserts with PCN/audit using code:activationId:handoff; legacy explicit enqueue and ambiguity handling retained |
| PcnDocumentFiles | Id uniqueidentifier; PcnCode FK; FileName/ContentType; Bytes varbinary(max); SizeBytes; ScanStatus/CreatedAt | Actual content, 10 MiB limit, pendingScan quarantine; clean scan required for download |
| SchemaMigrations | MigrationId nvarchar(120) PK; Checksum char(64); AppliedAt datetime2(3) | Created by migration runner; checksum mismatch rejects modified applied migrations |

There are 21 application tables in the core migration plus SchemaMigrations. The runner creates the application schema and migration metadata before versioned core DDL. Application startup checks readiness and never runs DDL.

Migration 002 historically added nullable `EmployeeCode`/`NormalizedEmployeeCode`, `DepartmentKey`, `AdObjectGuid`, `AdSid` and `DisplayName` plus unique non-null identity indexes. Migration 003 retains those historical columns and adds `IdentityProvider` (`password`, `employee-code`, `retired-windows`) with integrity constraints. Old AD users are retired and their sessions/tokens revoked. New employee accounts have a canonical source code, administrator-assigned department/roles, null password and no AD mapping. Explicit links preserve user ID, roles, department and ownership while clearing obsolete AD/password state and revoking sessions. No source row grants access automatically and no new duplicate user table is needed.

The SQL connection account `scndb` is not an end-user identity. Legacy bootstrap created `itadmin` from private environment values. Current runtime creation resolves an administrator-selected SQL-source employee and assigns explicit PCN roles/department without a PCN password. The source has unique non-null `EmpCode nvarchar(10)`, English/Thai names, job-title and source-department hints, but no email or active flag. No source data is written and no plaintext application password is stored in SQL.

Legacy groups: signoff.gscTet, signoff.prodEngTet, signoff.qaTet, tapbu.gsc, tapbu.qa, qateFinal.signoff, supplierNotification. Local schema 2 uses department.{gscTet,prodEngTet,qaTet,gscTapbu,qaTapbu}.{approved,checked,prepared} plus supplierNotification; QA final judgment reuses QA/TET lists. Legacy contacts are preserved server-side and explicitly copied by an administrator. Signed URLs remain backend configuration; import excludes routing. See [routing design](mail-routing-design.md).

## Transaction and import behavior

- Create allocates the annual counter, parent, review, ordered children and audit together.
- Updates lock/compare the parent version, validate actor/fields/state, save aggregate/audit, then return the new version. Comments/approvals use the same aggregate transaction.
- Soft delete preserves evidence and hides ordinary reads. Attachment writes revalidate the actor, lock the parent, check ownership/stage/version, enforce quotas and update the parent version/audit/history atomically. Local migration 005 changes file removal to soft removal, preserving bytes; a retention policy is pending.
- Settings save updates singleton/groups/profiles/audit transactionally. Local schema-2 PUT/PATCH require all 16 groups and a fetched hash version compared under SQL lock; server-owned legacyGroups remain in JSON.
- Local policy 2 calls notification prepare/persist hooks inside PCN create/update transactions, stores activation state in LegacyExtrasJson and a unique EventKey in NotificationJobs. The transient response is not persisted. Existing/absent-policy PCNs retain separate legacy enqueue; no routing-event/snapshot table exists.
- Missing recipients/configuration persist a blocked handoff, not a job. Later settings edits do not release it. Supplier action/reset cancels only pending jobs; status-only closure retains a queued final supplier notice. Sending/accepted/uncertain jobs are not recalled.
- Import preserves records, child order, unknown fields/null shape, audits and annual counters; unchanged source hashes skip, conflicts reject, no history mail is sent.
- Import accepts reviewed application JSON, not native Firestore export files. The three records in data/pcn-db.json are synthetic and must not be assumed authoritative.

## Future schema and release checks

The earlier full migration design includes Suppliers/UserSuppliers, LegacyIdentityLinks, PcnSignoffEvents, NotificationAttempts, ApiIdempotencyKeys and MigrationBatches. These tables are not in the implemented core migration. Company scope, invitation/reset flows, signoff events, general request idempotency, scan pipeline and mail operations require further implementation.

- [x] Apply SQL2014-compatible migration on the target and verify manifest/table/master readiness.
- [x] Historical migration 002 / selected AD administrator / Windows sign-in pilot; superseded by employee-code authentication.
- [x] Apply migration 003 unchanged against SQL2014, retire old identity sessions and provision only the separately approved employee administrator; signed 10-1 local/HTTPS acceptance passed.
- [ ] Observe live account linking and pilot signing/ownership flows; isolated automated coverage is recorded separately.
- [x] Confirm empty routing and hashed first account without exposing credentials.
- [ ] Reconcile actual source counts, payloads, null/omitted fields, audits, counters and unresolved owners.
- [x] Verify live transactions, Unicode workbook fields, stale-version rejection and rollback.
- [ ] Verify live concurrent allocation and backup/restore behavior.
- [x] Verify actual attachment bytes, quarantine, deletion and audit separately from uploaded flags.
- [ ] Restrict migration archives and sensitive identity tables; use a separate DDL-capable migration account where feasible.
- [ ] Complete operational policies for scanning, file retention, job cancellation/uncertain outcomes and secret configuration.

Before migration 003, a DPAPI-encrypted logical export of 22 PCN tables / 121 rows passed decryption/SHA-256 verification. This is not a native SQL backup and full restore was not tested. The source remained read-only; current account counts and release/test scope are in the linked acceptance record.

Related: [API inventory](sql-server-api-checklist.md), [migration plan](sql-server-migration.md), [setup](../README.md).
