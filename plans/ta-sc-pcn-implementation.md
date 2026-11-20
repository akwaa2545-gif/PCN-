# TA / SC PCN Implementation Plan

> **For agentic workers:** Use the approved design and implement the owned task with tests first. Do not revert other workers' changes.

**Goal:** Issue TA/SC codes at creation, route each to its own PE team, and filter Records by PCN type while preserving legacy documents.

**Architecture:** A shared browser/Node `pcn-types.js` owns code parsing, Bangkok issue dates and stage-to-department resolution. New records use typed IDs; existing PCN IDs and PE signature paths stay valid. SQL issuance is transactional and idempotent; permission, mail and deadline code resolve the record's PE team centrally.

**Tech Stack:** Existing Node/CommonJS, browser JavaScript, SQL Server 2014-compatible SQL and Playwright.

**Spec:** [TA / SC flow](ta-sc-pcn-flow.md).

## Global constraints

- `documentType`: `ta` or `sc`; TA codes `T-ddmmyy01`, SC codes `S-ddmmyy01`.
- Separate daily `01`–`99` sequences using Asia/Bangkok dates, never wrap/recycle.
- One PE stage and existing signature storage; departments `prodEngTa` / `prodEngSc`, with `prodEngTet` retained for legacy records.
- No historical renumbering, implicit staff grants, live account/PCN writes, mail sends or deployment.
- Prepare any required SQL migration as a reviewable file before requesting execution approval.

## Review focus

- Concurrent issuance, retries, deleted-code reuse and Bangkok midnight.
- A TA user must not sign, receive SC action mail or gain SC approval authority.
- Type/code immutability after creation and copy-with-new-code behavior.
- Legacy IDs, assignments, saved views, links, files and signed evidence must keep working.
- Current signing prerequisites, closure, read-only views and A4 output must survive the new code format.

## Tasks and ownership

- [x] Shared domain: root creates `pcn-types.js` with `normalizeType`, `typeOf`, `parseCode`, `isCode`, `formatCode`, `bangkokDay`, `departmentForStage`, `departmentLabel`, `peLabel` and `CODE_PATTERN`.
- [x] Identity backend: creation/service/template validation, SQL typed allocation, immutable type, hydration, migration and memory/API fixture updates. Tests first for code/date/retry/concurrency contracts.
- [x] Permissions and routing: signing assignments, record-aware authorization, workflow responsibility, notification audience and deadline settings; prove cross-team denial and legacy compatibility.
- [x] Creation/form UI: required type selection, fresh code on copy, form labels, signature locks and print labels using shared helpers.
- [x] Records/admin UI: type filter, persistence/export, PE assignments, mail groups and independent PE limits.
- [x] Integration: root updates all remaining validators, assets, release packaging and Teams link rules. Run focused tests, full coverage, isolated browser journeys, independent reviews and document deployment prerequisites.

Each task writes failing regression tests, implements, runs its focused tests and reports changed files. Root resolves integration failures and marks checkboxes only after verification.

## Local verification — 2026-11-19

- Full unit/API suite: **1,186 passed**, zero failures. Coverage: **89.04% lines / 91.74% branches / 94.67% functions**, using `node --test --experimental-test-coverage --test-concurrency=4`; evidence `test-results/ta-sc-full-coverage.log`.
- New TA/SC browser acceptance passes issuance, independent counters, required selection/no untyped autosave, first-save/reload type locking, all six typed PE signatures, opposite-team denial, legacy links and composed Records filters/views/CSV. Desktop/mobile screenshots and trace: `test-results/ta-sc-*`.
- Existing creation, 19 Records journeys, Mail Routing and System Settings browser checks pass. Settings verify independent TA/SC allowances and ongoing clock preservation; mail routing verifies seven departments and 22 lists.
- Document control, signing-order and full browser smoke regressions also pass. Native Edge and Chromium print acceptance generated **36 one-page A4 PDFs**: 32 typed combinations (TA/SC, both form layouts, draft/signed, desktop/mobile, both browsers) and four legacy historical-shape PDFs. The complete forms fill the printable width, retain the proper PE labels, saved signatures, identity and final section, and restore screen styling. Headless print-button cancellation is modeled explicitly; direct PDF printing uses genuine browser print events. Evidence: `test-results/print-layout-native-*.json` and `test-results/pcn-a4-native-*.pdf`.
- Independent code, JavaScript and security/SQL reviews report no introduced actionable findings. SQL concurrency is covered by isolated adapter/locking contracts; no real SQL race exercise or operational mail was performed.
- Teams expression updates remain an offline draft: no Power Automate runtime validation or live flow changes.

## Operational activation — completed 2026-11-19

The user explicitly approved migration `sql/migrations/009_pcn_document_types.sql`. The guarded runner verified the exact `SVR120A / Scn_DB` target and matching baseline 001–008 checksums, then applied only 009 and its checksum metadata inside a serializable transaction protected by the schema migration lock. It committed at `2026-11-19T08:09:38.185Z` with SHA-256 `eda11106fb80dcfd5711ffda4d9cebcf1c63eaa920452b3b795efca4573e901d`.

Before/after checks retained **11 PCNs, 10 users, 4 role grants, 1 master-data version, 1 mail-settings row, 1 workflow-settings row and 107 audit rows**. PCN versions, user access versions/assignments and role-grant snapshots were identical inside the transaction. The daily-counter table exists and both counter checks plus the expanded signing-department check are enabled and trusted. No user bootstrap, master-data seeding, reclassification or test mail was performed. Evidence: `test-results/ta-sc-009-activation.json` and the scoped runner `test-results/activate-ta-sc-migration.cjs`.

Migration 009 is registered in the append-only manifest and the counter table is mandatory for startup readiness. Regression tests first failed without registration, then passed with it. The live configured SQL adapter reports `{ready:true,migrations:9}`; the development watcher restarted and `/api/ready` plus `/pcn-types.js` returned HTTP 200. Administrators configure the new PE assignments and recipient lists explicitly. Signed runtime deployment remains separate.

## First-save usability follow-up — 2026-11-19

The user reported that selecting a type immediately locked it, and explicitly chose to keep TA/SC editable until the first **Save draft** click. The cause was background creation 1.5 seconds after the initial selection. New Create sessions now require explicit first-save authorization; the initial autosave timer, Review/readiness, Preview, attachment queue and Submit cannot allocate a code. Later edits on a saved or resumed draft still autosave.

The helper is neutral text describing the editable, saving and issued-code states. A first write with an uncertain response holds the selected type for an idempotent retry; an invalid untyped save attempt leaves it editable. Stopped save callbacks cannot overwrite a newly started document's type. Regression tests were observed failing before each behavioral fix, then passed; the focused creation set passes 70 tests. The final full suite passes **1,191 tests** with **88.84% line / 91.78% branch / 94.67% function coverage** (`test-results/type-first-save-coverage.log`).

The TA/SC and complete creation browser suites pass, including repeated typed selection beyond the debounce/throttle, Review/Preview/readiness/upload without initial creation, held explicit Save, saved/resumed autosave, same-identity retry and a delayed old background PATCH after starting a new SC document. Desktop/mobile pre-save screenshots are under `test-results/ta-sc-type-before-first-save-*`. Independent code and JavaScript reviews approve the final source. Local readiness and the served helper/manual-save assets were verified. No database change or historical reclassification is part of this follow-up.

## Type selection cards — 2026-11-19

At the user's request, Create replaces its dropdown with two large native radio cards labelled **TA** and **SC**, without Production Engineering text. Navy borders and a visible checkmark show the selected card, with a gold accent and a separate keyboard focus ring. The existing explicit first-save, retry, copy/resume and immutable-code rules remain in effect. The canonical value is kept in the existing model field; this is a frontend change only.

The native cards retain arrow-key/Tab interaction, required-field focus and helper/error associations. They fit desktop, 390px and 320px layouts; the smallest cards are 120×96px. Code, JavaScript and accessibility reviews approve the final component, including independently checked native keyboard behavior and actual indicator/focus colors. Browser harnesses now operate the visible radio controls rather than the former dropdown; official document form controls are unchanged.

The complete unit/API suite passes **1,191 tests** (`test-results/type-cards-full.log`). Both TA/SC and full creation browser suites pass; screenshots of the final selector are `test-results/ta-sc-type-cards-{desktop,mobile,mobile-320}.png`. The local server serves the new cards and returns HTTP 200 readiness. No SQL or operational mail actions were used for this UI change.
