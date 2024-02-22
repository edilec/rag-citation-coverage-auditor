# Exported Citation Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit declared answer claims against explicit citation support in an approved local source export.

**Architecture:** A bounded JSON reader validates a complete source/claim inventory. A pure audit resolves citation IDs, checks approval, scope and freshness, and counts claim support only from explicit `supportsClaims` relations. A frozen rule table controls findings and exit status.

**Tech Stack:** Node.js ESM >=22, `node:test`, `node:assert/strict`, no dependencies.

**Spec:** `docs/design.md`

## Global Constraints

- Offline, read-only, no dependencies, no network/provider code.
- Input claims and source prose are never treated as authority or echoed into findings.
- Missing support, permission or freshness evidence is incomplete; known mismatch fails.
- Code-unit deterministic order, explicit `asOf` date, injected processing clock.
- Both sides of every byte/count/depth/time bound tested and mutation-defended.

---

### Task 1: Validate bounded export and honest report shape

**Files:** Create `src/index.mjs`, `test/input.test.mjs`; modify `package.json`.

**Interfaces:** `auditCitations(exported, {scope,asOf,maxAgeDays,limits,now} = {})` returns a report; `auditFile(path, options)` reads bounded strict UTF-8 JSON; `renderReport` and `exitCodeFor` expose the house envelope.

- [ ] Write one supported claim/good source test with literal expected `status: 'pass'`, zero findings, claim denominator 1; run red.
- [ ] Implement configuration validation, strict schema and bounded input reader. An unreadable or invalid named input becomes an incomplete report; bad CLI configuration remains empty stdout.
- [ ] Add each N/N+1 test for `maxBytes`, `maxSources`, `maxClaims`, `maxCitations`, `maxSupportRelations`, `maxDepth` and `timeoutMs`, watching red then green.
- [ ] Run focused tests; commit `feat: validate bounded citation exports`.

### Task 2: Resolve citations and explicit claim support

**Files:** Modify `src/index.mjs`; create `test/audit.test.mjs`.

**Interfaces:** Export is `{schemaVersion:'1',inventoryComplete:true,sources:[{id,approved,permissions,observedAt,supportsClaims}],claims:[{id,citations}]}`. Report coverage has `{resolvedCitations:{numerator,denominator},usableCitations:{numerator,denominator},coveredClaims:{numerator,denominator}}`.

- [ ] Write fabricated citation ID case; assert `citation-unresolved`, status fail and exit 1; run red, implement.
- [ ] Write a present source with explicit empty support list; assert uncovered claim and zero numerator, run red, implement. Contrast explicit missing support relation as incomplete, not fail.
- [ ] Test known denied scope/stale/unapproved fail versus unknown permission/freshness incomplete, and a future observation incomplete. Run each red before implementation.
- [ ] Test multi-claim/multi-citation denominators with literal hand-counted values and code-unit ordering; mutate support check and severity to watch named tests fail.
- [ ] Run focused tests; commit `feat: audit cited claim support`.

### Task 3: CLI, examples and documentation

**Files:** Create `bin/rag-citation-coverage-auditor.mjs`, `examples/*.json`, `test/cli.test.mjs`; replace `README.md`, `docs/README.md`; modify `package.json`.

**Interfaces:** `--input FILE --scope ID --as-of YYYY-MM-DD [--max-age-days N] [limit flags] [--json]`; stdout is one report, except invalid usage whose stdout is empty.

- [ ] Write subprocess tests for clean/fabricated/unknown-evidence exports and usage/input-error exit shapes; run red.
- [ ] Implement CLI, help, scripts, and runnable passing/failing examples.
- [ ] Document schema, explicit support/denominators, rule table, limits, exit codes and non-goals.
- [ ] Run `npm run check`, examples, output determinism probe, control/attribution scan and `git diff --check`; commit `feat: ship offline citation audit CLI`.
