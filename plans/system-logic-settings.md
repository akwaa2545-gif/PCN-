# Admin system logic settings — design

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
