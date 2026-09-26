# Exported citation audit design

This tool audits a local, structured JSON export. It does not retrieve a
source, parse arbitrary answer prose, query permissions, or decide semantic
truth. A citation ID's presence is not support: the export must explicitly
state that its source supports the particular declared claim.

The versioned export has `schemaVersion: "1"`, `inventoryComplete: true`, a
nonempty `sources` array and a nonempty `claims` array. Source IDs and claim
IDs are unique short ASCII identifiers. A source supplies `approved` as a
boolean, `permissions` as an array of scope IDs, `observedAt` as a UTC date,
and `supportsClaims` as an explicit array of claim IDs. Each claim supplies
an ID and an array of citation IDs. The CLI requires `--input`, `--scope`,
and `--as-of YYYY-MM-DD`; `--max-age-days` defaults to 30. The date is
injected, never read from a wall clock.

For each citation the audit checks that the ID resolves in a declared-complete
inventory, is approved, permits the requested scope, and is fresh at the
declared date. For each claim it counts support only when at least one of its
cited, approved, permitted, fresh sources explicitly lists that claim ID in
`supportsClaims`. A fabricated ID in a complete inventory is a known failure;
a citation to an existing source with no declared support is an uncovered
claim, also a failure. Known denied permission, stale source or unapproved
source fails. Missing inventory completeness, permission, freshness or support
evidence is incomplete rather than assumed false or clean. A future date is
invalid evidence, not proof of freshness. The report exposes separate
numerator/denominator objects for resolved citations, usable citations and
covered claims; unknown denominators become null instead of misleading zero.
It emits only validated IDs and pointers, not claim or source text.

Bad CLI usage has empty stdout and exit 2. A named input that cannot be read,
decoded, parsed or validated returns an incomplete JSON report and exit 2.
Limits cover input bytes, source count, claim count, citation references,
support relations, JSON nesting and elapsed processing time. The timeout
uses an injected clock and cooperative checks; a single filesystem operation
may overshoot before the next check. Every bound is tested at N and N+1.
The tool never writes files and never makes a network call. Findings have a
frozen rule/severity table and code-unit deterministic order.

The package ships `src/`, `bin/`, passing and failing examples, `node:test`
coverage, zero dependencies, and `lint`, `test`, `check` scripts. The README
defines the export, honest denominators, rule table, limits, exit shapes and
non-goals. Each documented behavioral guarantee has a test shown to fail
when the corresponding check is removed.
