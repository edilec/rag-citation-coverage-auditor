# RAG Citation Coverage Auditor

Audit a *local export* of declared answer claims, citation IDs and approved
retrieval sources. A cited ID merely proves that an ID was written; it is not
evidence that the source supports the claim. This tool requires an explicit
source-to-claim support relation and reports unknown permission or freshness
instead of quietly treating it as approval.

It is a read-only reporter with zero runtime and development dependencies
(Node.js 22+). It writes no files, fetches no source, resolves no host, contacts
no provider or account, and does not decide whether a claim is actually true.

## Quick start

```sh
node bin/rag-citation-coverage-auditor.mjs --input examples/passing.json --scope public --as-of 2026-09-20
node bin/rag-citation-coverage-auditor.mjs --input examples/failing.json --scope public --as-of 2026-09-20 --json
npm run check
```

The passing export exits 0; the fabricated citation exits 1. stdout is one
JSON report and a newline. Without `--json` a short human summary is on
stderr. `--help` goes to stderr and leaves stdout empty.

## Export contract

The named JSON input has this shape:

```json
{
  "schemaVersion": "1",
  "inventoryComplete": true,
  "sources": [{
    "id": "source-one",
    "approved": true,
    "permissions": ["public"],
    "observedAt": "2026-09-15",
    "supportsClaims": ["claim-one"]
  }],
  "claims": [{ "id": "claim-one", "citations": ["source-one"] }]
}
```

IDs are unique ASCII strings beginning with a letter, followed by at most
63 letters, digits, `_` or `-`. Each `supportsClaims` ID names a declared
claim. The lists are exported evidence, not a judgement made by this tool.
`approved: false`, an explicit permission list without the requested scope,
or a source older than `--max-age-days` is a *known mismatch* and fails. If
`approved`, `permissions`, `observedAt` or `supportsClaims` is absent, the
corresponding evaluation is unknown and the run is incomplete. Invalid or
future `observedAt` is unknown freshness, not fresh. The operator must supply
`--as-of YYYY-MM-DD`; the tool never reads the calendar for the audit date.

`inventoryComplete: true` lets an absent citation ID be called fabricated
relative to this export and fail. If completeness is false or omitted, an
absent ID remains unresolved evidence, so the run is incomplete. A source in
the inventory with an explicit empty `supportsClaims` list is known not to
support the declared claim. At least one cited, approved, permitted, fresh
source must explicitly list the claim ID to cover it. Empty citation lists
are uncovered. Duplicate citation occurrences count as separate references;
they do not create claim support by repetition.

The report has three separate numerator/denominator pairs:

| Metric | Numerator | Denominator |
| --- | --- | --- |
| `resolvedCitations` | Citation references found in a complete source inventory; null if inventory completeness is unknown. | All declared citation references. |
| `usableCitations` | Resolved, approved, permitted and fresh references; null when a cited source's usability is unknown. | All declared citation references. |
| `coveredClaims` | Claims with at least one explicitly supporting usable citation; null when an uncovered claim might still be supported by unknown evidence. | All declared claims. |

An invalid/unreadable export has all denominators null rather than pretending
it declared zero. Claim/source prose is never echoed; the report uses only
validated IDs indirectly through positions and controlled messages.

## Rules

| Rule ID | Severity | Meaning |
| --- | --- | --- |
| `citation-unresolved` | error | ID absent from a declared-complete inventory; fail. |
| `claim-uncovered` | error | No cited usable source explicitly supports the claim; fail. |
| `source-unapproved`, `permission-denied`, `source-stale` | error | Known approval, scope or age mismatch; fail. |
| `inventory-unknown`, `approval-unknown`, `permission-unknown`, `freshness-unknown`, `support-unknown` | warning | Required evidence missing; incomplete, not pass. |
| `input-invalid`, `input-unreadable` | error | Named export unusable; incomplete. |
| `byte-limit-exceeded`, `source-limit-exceeded`, `claim-limit-exceeded`, `citation-limit-exceeded`, `support-limit-exceeded`, `depth-limit-exceeded`, `analysis-timeout` | error | Bound exceeded; incomplete. |

Findings sort by `(location.file, location.pointer, ruleId)` in UTF-16
code-unit order. Severity and incompleteness come from a frozen rule table;
an unknown rule ID cannot be emitted. An incomplete finding takes priority
over any known failure in aggregate status.

## Limits and exit shape

| Flag | Default | Bound |
| --- | ---: | --- |
| `--max-bytes` | 1048576 | Bytes in the named export; reads at most N+1. |
| `--max-sources` | 1000 | Source records. |
| `--max-claims` | 1000 | Declared claims. |
| `--max-citations` | 10000 | Total citation references. |
| `--max-support-relations` | 10000 | Total source-to-claim relations. |
| `--max-depth` | 16 | Object/array nesting depth. |
| `--timeout-ms` | 30000 | Elapsed processing time after configuration. |
| `--max-age-days` | 30 | Policy age in whole UTC days; zero allowed. |

Ambiguous JSON objects with duplicate keys are incomplete, including escaped
spellings of the same key; an earlier declaration cannot be overwritten.
Input bounds stay silent at N and return incomplete at N+1. Library callers
use camelCase `limits` keys and may inject `now` for an exact deadline; the
clock is never printed. Unknown limit names are invalid configuration. Time
checks are cooperative: one filesystem operation or JSON parse can finish
after the deadline before the next check. Actual elapsed time varies with
load; completed reports are byte-identical for the same input and options.

| Exit | stdout | Meaning |
| ---: | --- | --- |
| 0 | pass JSON | All declared checks complete and satisfied. |
| 1 | fail JSON | Complete evidence proves a mismatch. |
| 2 | empty | Invalid CLI/configuration, diagnostic on stderr. |
| 2 | incomplete JSON | Named input unreadable/invalid, required evidence unknown, or bound exceeded. |

## Non-goals

No Markdown citation extraction, model-judged entailment, source retrieval,
permission query, browser/database connection, auto-repair or account change.
The support relation is a claim *from the export*, not independently verified
truth; inspect the source and relation provenance separately. Do not put real
personal data or credentials in fixtures or reports. MIT licensed; see
[LICENSE](./LICENSE).
