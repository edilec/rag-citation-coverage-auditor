import assert from 'node:assert/strict'
import test from 'node:test'

import { auditCitations, exitCodeFor, renderReport } from '../src/index.mjs'

export function goodExport() {
  return {
    schemaVersion: '1', inventoryComplete: true,
    sources: [{ id: 'SRC1', approved: true, permissions: ['public'], observedAt: '2026-09-15', supportsClaims: ['C1'] }],
    claims: [{ id: 'C1', citations: ['SRC1'] }],
  }
}

const options = { scope: 'public', asOf: '2026-09-20', maxAgeDays: 30, now: () => 0 }
const ids = (report) => report.findings.map((finding) => finding.ruleId)

test('an explicitly supporting, approved, permitted, fresh citation passes without a finding', () => {
  const report = auditCitations(goodExport(), options)
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.deepEqual(ids(report), [])
  assert.deepEqual(report.coverage.resolvedCitations, { numerator: 1, denominator: 1 })
  assert.deepEqual(report.coverage.usableCitations, { numerator: 1, denominator: 1 })
  assert.deepEqual(report.coverage.coveredClaims, { numerator: 1, denominator: 1 })
  assert.equal(report.summary.checked, 1)
  assert.equal(renderReport(report).endsWith('\n'), true)
})

test('shared in-memory metadata is valid while a genuine cycle is incomplete', () => {
  const input = goodExport()
  const second = { ...input.sources[0], id: 'SRC2' }
  input.sources.push(second)
  second.permissions = input.sources[0].permissions
  second.supportsClaims = input.sources[0].supportsClaims
  input.claims[0].citations.push('SRC2')
  const shared = auditCitations(input, options)
  assert.equal(shared.status, 'pass')
  assert.deepEqual(shared.findings, [])
  assert.deepEqual(shared.coverage.resolvedCitations, { numerator: 2, denominator: 2 })
  const roundTrip = auditCitations(JSON.parse(JSON.stringify(input)), options)
  assert.deepEqual(shared, roundTrip)

  input.extra = input
  const cyclic = auditCitations(input, options)
  assert.equal(cyclic.status, 'incomplete')
  assert.deepEqual(ids(cyclic), ['input-invalid'])
})

test('a fabricated ID in a complete inventory fails, never counts as resolved', () => {
  const input = goodExport()
  input.claims[0].citations = ['FABRICATED']
  const report = auditCitations(input, options)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(ids(report), ['claim-uncovered', 'citation-unresolved'])
  assert.equal(report.findings[1].severity, 'error')
  assert.deepEqual(report.coverage.resolvedCitations, { numerator: 0, denominator: 1 })
  assert.deepEqual(report.coverage.coveredClaims, { numerator: 0, denominator: 1 })
})

test('a fabricated citation fails on its own even when another citation covers the claim', () => {
  const input = goodExport()
  input.claims[0].citations.push('FABRICATED')
  const report = auditCitations(input, options)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(ids(report), ['citation-unresolved'])
  assert.equal(report.findings[0].severity, 'error')
  assert.deepEqual(report.coverage.coveredClaims, { numerator: 1, denominator: 1 })
  assert.deepEqual(report.coverage.resolvedCitations, { numerator: 1, denominator: 2 })
})

test('source presence without explicit claim support is uncovered, not a pass', () => {
  const input = goodExport()
  input.sources[0].supportsClaims = []
  const report = auditCitations(input, options)
  assert.equal(report.status, 'fail')
  assert.deepEqual(ids(report), ['claim-uncovered'])
  assert.deepEqual(report.coverage.resolvedCitations, { numerator: 1, denominator: 1 })
  assert.deepEqual(report.coverage.usableCitations, { numerator: 1, denominator: 1 })
  assert.deepEqual(report.coverage.coveredClaims, { numerator: 0, denominator: 1 })
})

test('missing claim-support relation is incomplete rather than treated as empty', () => {
  const input = goodExport()
  delete input.sources[0].supportsClaims
  const report = auditCitations(input, options)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(ids(report), ['support-unknown'])
  assert.deepEqual(report.coverage.coveredClaims, { numerator: null, denominator: 1 })
})

test('unknown inventory, permission and freshness are incomplete, not invented absence', () => {
  const cases = [
    ['inventory-unknown', (input) => { input.inventoryComplete = false; input.claims[0].citations = ['UNKNOWN'] }, 'resolvedCitations'],
    ['permission-unknown', (input) => { delete input.sources[0].permissions }, 'usableCitations'],
    ['freshness-unknown', (input) => { delete input.sources[0].observedAt }, 'usableCitations'],
    ['freshness-unknown', (input) => { input.sources[0].observedAt = '2026-09-21' }, 'usableCitations'],
  ]
  for (const [rule, mutate, metric] of cases) {
    const input = goodExport()
    mutate(input)
    const report = auditCitations(input, options)
    assert.equal(report.status, 'incomplete', rule)
    assert.deepEqual(ids(report), [rule], rule)
    assert.equal(report.coverage[metric].numerator, null, rule)
    assert.equal(report.coverage[metric].denominator, 1, rule)
  }
})

test('known unapproved, denied and stale sources fail rather than become permission unknown', () => {
  const cases = [
    ['source-unapproved', (input) => { input.sources[0].approved = false }],
    ['permission-denied', (input) => { input.sources[0].permissions = ['internal'] }],
    ['source-stale', (input) => { input.sources[0].observedAt = '2026-09-14' }],
  ]
  for (const [rule, mutate] of cases) {
    const input = goodExport()
    mutate(input)
    const report = auditCitations(input, { ...options, maxAgeDays: 5 })
    assert.equal(report.status, 'fail', rule)
    assert.ok(ids(report).includes(rule), rule)
    assert.ok(ids(report).includes('claim-uncovered'), rule)
    assert.deepEqual(report.coverage.usableCitations, { numerator: 0, denominator: 1 })
  }
})

test('known denial does not hide independently missing permission and freshness evidence', () => {
  const input = goodExport()
  input.sources[0].approved = false
  delete input.sources[0].permissions
  delete input.sources[0].observedAt
  const report = auditCitations(input, options)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['freshness-unknown', 'permission-unknown', 'source-unapproved'])
  assert.deepEqual(report.coverage.usableCitations, { numerator: null, denominator: 1 })
  assert.deepEqual(report.coverage.coveredClaims, { numerator: null, denominator: 1 })
})

test('freshness stays silent at exactly N days and fails at N+1', () => {
  const input = goodExport()
  assert.equal(auditCitations(input, { ...options, maxAgeDays: 5 }).status, 'pass')
  assert.deepEqual(ids(auditCitations(input, { ...options, maxAgeDays: 4 })), ['claim-uncovered', 'source-stale'])
})

test('multiple claims and references keep explicit, independently counted denominators', () => {
  const input = goodExport()
  input.sources.push({ id: 'SRC2', approved: true, permissions: ['public'], observedAt: '2026-09-15', supportsClaims: [] })
  input.sources[0].supportsClaims.push('C2')
  input.claims[0].citations.push('SRC2')
  input.claims.push({ id: 'C2', citations: ['SRC1'] })
  const report = auditCitations(input, options)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.coverage, {
    resolvedCitations: { numerator: 3, denominator: 3 },
    usableCitations: { numerator: 3, denominator: 3 },
    coveredClaims: { numerator: 2, denominator: 2 },
  })
  assert.equal(renderReport(report), renderReport(auditCitations(input, options)))
})

test('deadline after an observed claim withholds partial semantic findings and denominators', () => {
  const input = goodExport()
  input.claims.push({ id: 'C2', citations: ['SRC1'] })
  let supportReads = 0
  Object.defineProperty(input.sources[0], 'supportsClaims', {
    enumerable: true,
    get() { supportReads += 1; return ['C2'] },
  })
  const report = auditCitations(input, {
    ...options, limits: { timeoutMs: 1 },
    now: () => (supportReads >= 8 ? 2 : 0),
  })
  assert.ok(supportReads >= 8, `analysis did not reach a citation: ${supportReads}`)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(ids(report), ['analysis-timeout'])
  assert.deepEqual(report.coverage.coveredClaims, { numerator: null, denominator: null })
  assert.equal(report.summary.checked, 0)
})
