import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditCitations, auditFile, exitCodeFor, renderReport } from '../src/index.mjs'

const fixture = () => ({
  schemaVersion: '1', inventoryComplete: true,
  sources: [{ id: 'S1', approved: true, permissions: ['public'], observedAt: '2026-09-15', supportsClaims: ['C1'] }],
  claims: [{ id: 'C1', citations: ['S1'] }],
})
const options = { scope: 'public', asOf: '2026-09-20', now: () => 0 }
const ids = (report) => report.findings.map((finding) => finding.ruleId)

test('empty or malformed exports are incomplete, never vacuously green', () => {
  const empty = fixture()
  empty.claims = []
  assert.deepEqual(ids(auditCitations(empty, options)), ['input-invalid'])
  const invalidId = fixture()
  invalidId.sources[0].id = 'private\u202e\ntext'
  const report = auditCitations(invalidId, options)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['input-invalid'])
  assert.ok(!renderReport(report).includes('private'))
})

test('unknown option names and invalid as-of/scope are configuration errors', () => {
  assert.throws(() => auditCitations(fixture(), { ...options, limits: { maxSource: 1 } }), /Unknown limit/)
  assert.throws(() => auditCitations(fixture(), { ...options, asOf: '2026-02-30' }), /asOf/)
  assert.throws(() => auditCitations(fixture(), { ...options, scope: '' }), /scope/)
})

test('source and claim bounds are silent at N and incomplete at N+1', () => {
  const base = fixture()
  assert.equal(auditCitations(base, { ...options, limits: { maxSources: 1, maxClaims: 1 } }).status, 'pass')
  const sources = fixture()
  sources.sources.push({ ...structuredClone(sources.sources[0]), id: 'S2' })
  assert.deepEqual(ids(auditCitations(sources, { ...options, limits: { maxSources: 1 } })), ['source-limit-exceeded'])
  const claims = fixture()
  claims.claims.push({ id: 'C2', citations: ['S1'] })
  assert.deepEqual(ids(auditCitations(claims, { ...options, limits: { maxClaims: 1 } })), ['claim-limit-exceeded'])
})

test('citation and support relation bounds are silent at N and incomplete at N+1', () => {
  assert.equal(auditCitations(fixture(), { ...options, limits: { maxCitations: 1, maxSupportRelations: 1 } }).status, 'pass')
  const cites = fixture()
  cites.claims[0].citations.push('S1')
  assert.deepEqual(ids(auditCitations(cites, { ...options, limits: { maxCitations: 1 } })), ['citation-limit-exceeded'])
  const support = fixture()
  support.claims.push({ id: 'C2', citations: ['S1'] })
  support.sources[0].supportsClaims.push('C2')
  assert.deepEqual(ids(auditCitations(support, { ...options, limits: { maxSupportRelations: 1 } })), ['support-limit-exceeded'])
})

test('nesting and time bounds are silent at N and incomplete at N+1', () => {
  assert.equal(auditCitations(fixture(), { ...options, limits: { maxDepth: 4 } }).status, 'pass')
  assert.deepEqual(ids(auditCitations(fixture(), { ...options, limits: { maxDepth: 3 } })), ['depth-limit-exceeded'])
  let reads = 0
  const atLimit = auditCitations(fixture(), { ...options, limits: { timeoutMs: 5 }, now: () => (reads++ === 0 ? 0 : 5) })
  reads = 0
  const exceeded = auditCitations(fixture(), { ...options, limits: { timeoutMs: 5 }, now: () => (reads++ === 0 ? 0 : 6) })
  assert.equal(atLimit.status, 'pass')
  assert.deepEqual(ids(exceeded), ['analysis-timeout'])
  assert.equal(exceeded.status, 'incomplete')
  assert.equal(exitCodeFor(exceeded), 2)
})

test('named file reads exactly N bytes and reports N+1, unreadable and invalid UTF-8', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rag-audit-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'export.json')
  const bytes = Buffer.from(JSON.stringify(fixture()))
  await writeFile(input, bytes)
  assert.equal((await auditFile(input, { ...options, limits: { maxBytes: bytes.length } })).status, 'pass')
  assert.deepEqual(ids(await auditFile(input, { ...options, limits: { maxBytes: bytes.length - 1 } })), ['byte-limit-exceeded'])
  assert.deepEqual(ids(await auditFile(join(root, 'missing.json'), options)), ['input-unreadable'])
  await writeFile(input, Buffer.from([0xff]))
  assert.deepEqual(ids(await auditFile(input, options)), ['input-invalid'])
})
