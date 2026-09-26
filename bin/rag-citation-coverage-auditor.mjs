#!/usr/bin/env node

import { ConfigError, DEFAULT_LIMITS, TOOL_ID, auditFile, exitCodeFor, renderReport } from '../src/index.mjs'

const HELP = `${TOOL_ID}

Audit a local approved-source export against declared claims and citation IDs.
An ID being present does not prove claim support; the export must explicitly
declare a source-to-claim support relation. No source is retrieved or fetched.

Usage: ${TOOL_ID} --input FILE --scope ID --as-of YYYY-MM-DD [--max-age-days N] [--json] [limits]

Options:
  --input FILE               Local JSON export (required)
  --scope ID                 Requested permission scope (required)
  --as-of YYYY-MM-DD         Explicit UTC audit date (required)
  --max-age-days N           Permitted source age, including zero (default 30)
  --json                      Omit human summary on stderr
  --max-bytes N               Input byte limit (default ${DEFAULT_LIMITS.maxBytes})
  --max-sources N             Source count limit (default ${DEFAULT_LIMITS.maxSources})
  --max-claims N              Claim count limit (default ${DEFAULT_LIMITS.maxClaims})
  --max-citations N           Total citation reference limit (default ${DEFAULT_LIMITS.maxCitations})
  --max-support-relations N   Total support relation limit (default ${DEFAULT_LIMITS.maxSupportRelations})
  --max-depth N               JSON/object nesting limit (default ${DEFAULT_LIMITS.maxDepth})
  --timeout-ms N              Processing time budget (default ${DEFAULT_LIMITS.timeoutMs})
  -h, --help                  Show this help

Exit: 0 complete/pass; 1 complete/known mismatch; 2 invalid usage (empty stdout)
or missing/invalid named evidence (incomplete JSON on stdout).
`

const LIMIT_FLAGS = Object.freeze({
  '--max-bytes': 'maxBytes', '--max-sources': 'maxSources',
  '--max-claims': 'maxClaims', '--max-citations': 'maxCitations',
  '--max-support-relations': 'maxSupportRelations',
  '--max-depth': 'maxDepth', '--timeout-ms': 'timeoutMs',
})

function parse(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const parsed = { input: null, scope: null, asOf: null, maxAgeDays: 30, json: false, limits: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') { parsed.json = true; continue }
    if (!['--input', '--scope', '--as-of', '--max-age-days'].includes(flag) && !Object.hasOwn(LIMIT_FLAGS, flag)) {
      throw new ConfigError('Unknown option')
    }
    const raw = argv[++index]
    if (raw === undefined || raw.length === 0 || raw.startsWith('--')) throw new ConfigError(`${flag} requires a value`)
    if (flag === '--input') parsed.input = raw
    else if (flag === '--scope') parsed.scope = raw
    else if (flag === '--as-of') parsed.asOf = raw
    else {
      if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || (flag !== '--max-age-days' && Number(raw) < 1)) {
        throw new ConfigError(`${flag} requires ${flag === '--max-age-days' ? 'a nonnegative' : 'a positive'} integer`)
      }
      if (flag === '--max-age-days') parsed.maxAgeDays = Number(raw)
      else parsed.limits[LIMIT_FLAGS[flag]] = Number(raw)
    }
  }
  if (parsed.input === null || parsed.scope === null || parsed.asOf === null) throw new ConfigError('--input, --scope and --as-of are required')
  return parsed
}

try {
  const options = parse(process.argv.slice(2))
  if (options.help) process.stderr.write(HELP)
  else {
    const report = await auditFile(options.input, options)
    process.stdout.write(renderReport(report))
    if (!options.json) process.stderr.write(`${TOOL_ID}: ${report.status}; ${report.summary.checked} claim(s) checked; ${report.summary.errors} error(s), ${report.summary.warnings} warning(s).\n`)
    process.exitCode = exitCodeFor(report)
  }
} catch (error) {
  process.stderr.write(`${TOOL_ID}: ${error instanceof ConfigError ? error.message : 'execution failed'}\n`)
  process.exitCode = 2
}
