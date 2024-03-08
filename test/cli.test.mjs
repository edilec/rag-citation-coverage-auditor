import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const cli = new URL('../bin/rag-citation-coverage-auditor.mjs', import.meta.url).pathname
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
const exported = () => ({
  schemaVersion: '1', inventoryComplete: true,
  sources: [{ id: 'SRC', approved: true, permissions: ['public'], observedAt: '2026-09-19', supportsClaims: ['C1'] }],
  claims: [{ id: 'C1', citations: ['SRC'] }],
})

test('CLI good, fabricated ID and unknown permission produce 0, 1 and 2 with JSON reports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rag-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'export.json')
  const args = ['--input', file, '--scope', 'public', '--as-of', '2026-09-20', '--json']
  await writeFile(file, JSON.stringify(exported()))
  const clean = run(...args)
  assert.equal(clean.status, 0)
  assert.equal(clean.stderr, '')
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const bad = exported()
  bad.claims[0].citations = ['FABRICATED']
  await writeFile(file, JSON.stringify(bad))
  const failed = run(...args)
  assert.equal(failed.status, 1)
  assert.deepEqual(JSON.parse(failed.stdout).findings.map((item) => item.ruleId), ['claim-uncovered', 'citation-unresolved'])

  const unknown = exported()
  delete unknown.sources[0].permissions
  await writeFile(file, JSON.stringify(unknown))
  const incomplete = run(...args)
  assert.equal(incomplete.status, 2)
  assert.deepEqual(JSON.parse(incomplete.stdout).findings.map((item) => item.ruleId), ['permission-unknown'])
})

test('bad CLI configuration has empty stdout; named unreadable input has incomplete stdout', () => {
  const help = run('--help')
  assert.equal(help.status, 0)
  assert.equal(help.stdout, '')
  assert.match(help.stderr, /--as-of YYYY-MM-DD/)
  for (const args of [[], ['--unknown'], ['--input', 'x', '--scope', 'public', '--as-of', '2026-02-30'], ['--input', 'x', '--scope', 'public', '--as-of', '2026-09-20', '--timeout-ms', '0']]) {
    const result = run(...args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
  }
  const missing = run('--input', '/not-a-real-edilec-citation-export.json', '--scope', 'public', '--as-of', '2026-09-20', '--json')
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stdout).status, 'incomplete')
})

test('duplicate JSON keys cannot replace unknown inventory evidence with a pass', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rag-duplicate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'export.json')
  const args = ['--input', file, '--scope', 'public', '--as-of', '2026-09-20', '--json']
  const good = JSON.stringify(exported())
  await writeFile(file, good)
  assert.equal(run(...args).status, 0)
  for (const ambiguous of [
    good.replace('"inventoryComplete":true', '"inventoryComplete":false,"inventoryComplete":true'),
    good.replace('"inventoryComplete":true', '"inventoryComplete":false,"inventor\\u0079Complete":true'),
  ]) {
    await writeFile(file, ambiguous)
    const result = run(...args)
    assert.equal(result.status, 2)
    assert.deepEqual(JSON.parse(result.stdout).findings.map((item) => item.ruleId), ['input-invalid'])
  }
})
