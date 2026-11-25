# Admin system logic settings — design

## Content of Changes master data — local follow-up, 2026-11-24

The user approved editing category wording, adding options, disabling/re-enabling options and assigning RL0–RL3 through **System Settings → Content of Changes**, for both Raw Material and Packaging. Administrator and valid Developer accounts can publish these settings. Saving requires a reason and the current master version; stale editors keep their changes and must reload deliberately.

Within each form, larger RL3, RL2, RL1 and RL0 headers group the options. Each risk group expands/collapses, shows option/enabled counts and provides an Add option action that assigns that group’s risk level. Grouping is a presentation detail; it must preserve each option’s underlying identity and values during risk changes.

Each publication creates an immutable `MasterDataVersions` snapshot and an audit entry in one transaction. Only category lists are writable; workflow stages, statuses, form identity and headings remain outside this settings API. Each form needs at least one enabled category, unique nonblank wording of at most 500 characters, and at most 100 options. Disabled options stay visible in the editor and disappear from new-document selection.

New documents use the current enabled master data. Existing documents—including drafts and signed legacy, TA and SC records—continue to validate, render and print using their saved `masterDataVersionId`. Legacy records without a version use the packaged baseline. A missing pinned version fails closed rather than substituting current defaults. Copying an old document into a new one uses current defaults and requires category selection if the former option is no longer available. Restarting or running initialization must preserve an existing active publication.

No schema migration or deployment is part of this local follow-up. The earlier dated review-limit decisions below remain applicable.

Verified locally with **1,418 passing unit/API tests**, **90.49% line, 91.28% branch and 94.47% function coverage**, and 7 isolated browser groups covering publication, grouped risk editing, new versus historical documents, conflicts, authorization and 320px layout. The browser checks confirm keyboard collapse/expand, per-risk Add, and risk changes moving the same option without losing focus. Existing creation, Developer correction and single-page A4 print journeys also passed. Code, JavaScript and security reviews have no unresolved findings. Local health/readiness checks returned `ok` and `ready`. Tests used disposable memory storage or SQL mocks; no live business records were modified by these checks. No deployment or push was performed.

Date: 2026-10-21. Status: implemented and verified locally; the user also approved migration 008 for the reported startup failure.

## Intended behavior

Administrators configure pending-day limits from a dedicated **System Settings** page linked from the Portal. The first supported system rule is the time allowed for each department review. Existing Administrator-equivalent Developer access follows the application's current permission model.

Each department row has an enabled control and a whole-number calendar-day limit from 1 to 365. Rows cover GSC/TET, Prod.Eng/TET, QA/TET, GSC/TaPBU, QA/TaPBU, and a separate QA/TET Final Judgment allowance. Final Judgment has its own row because it occurs after the initial QA review and any required TaPBU reviews.

Initial settings preserve current behavior: Prod.Eng/TET and QA/TET review allow three days; the other four allowances are disabled until an administrator configures them. The UI offers Save and Reload, clear success/error feedback, and last-change information. It rejects invalid values and prevents an older editor from overwriting a newer save.

The user explicitly selected **new and ongoing reviews**. A saved limit recalculates the deadline using the existing review start, without restarting its clock or modifying PCN signatures. Enabled rules control overdue rows, compact Pending time, department timelines and reminder/overdue scheduling. Pending time remains **1 day** or **Overdue 2 days**. Exact due dates stay in the timeline.

An active stage with no reliable recorded handoff remains unavailable rather than receiving an invented earlier start. Future stage entries are recorded even while an allowance is disabled, so enabling the rule later can use the original handoff. Completed, rejected, closed, draft and supplier-action records do not receive active review deadlines. Skipped TaPBU stages have no deadline. Configuration never changes the required signing order.

## Persistence and boundaries

- Add a dedicated SQL singleton settings table with configuration JSON, concurrency version, updated time and updated actor through an explicit migration. Preserve mail routing as a separate setting.
- Expose authenticated Administrator GET and PUT settings endpoints. Reuse existing same-origin, CSRF, rate-limit and active-account checks; recheck the saving actor inside the transaction.
- Validate an exact fixed set of rule keys and bounded integer day values. This screen does not accept executable code or arbitrary workflow expressions.
- Audit successful changes with before/after values. Save no PCN data and send no mail directly from the settings endpoint.
- Generalize stage timing with stable stage keys and backward-compatible reads of existing Prod.Eng/TET and QA/TET handoff timestamps. Apply current settings when reading deadlines and claiming queued mail.
- Revalidate queued notices against current limits and recipients. Cancel obsolete deadline notices; distinguish changed due dates in deduplication so a stale job cannot block a later valid notice.
- Include all new runtime assets in static-serving and release allowlists. Database migrations remain an explicit deployment step.

## Verification

Write tests before implementation for defaults, validation, permissions, CSRF, concurrent edits, SQL persistence/audits, every stage handoff and skip, disabled limits, ongoing deadline recalculation without clock resets, legacy unknown timing, completed stages, and notification rescheduling/deduplication.

Use isolated browser/API fixtures to verify administrator editing and reload, non-administrator denial, validation and stale-save errors, mobile layout, and changed limits updating both Portal and read-only Records through normal polling. Run the full unit/API coverage suite and relevant browser checks; review the code and security boundaries before completion. No live deployment or live database migration is included without a deployment request.

## Implementation sequence

1. Settings model, validation, SQL migration/repository and administrator API.
2. Generalized timing and current-policy integration into dashboards, timeline summaries and notification scheduling/claims.
3. Accessible System Settings page and Portal navigation/runtime packaging.
4. Isolated browser acceptance, full coverage, code/security/database review and updated implementation notes.
