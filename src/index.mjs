import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { hasDuplicateObjectKeys } from './json.mjs'

export const TOOL_ID = 'rag-citation-coverage-auditor'
export const SCHEMA_VERSION = '1'
export const byCodeUnit = (a, b) => (a === b ? 0 : a < b ? -1 : 1)
export class ConfigError extends Error {}
class DeadlineExceeded extends Error {}

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1048576, maxSources: 1000, maxClaims: 1000,
  maxCitations: 10000, maxSupportRelations: 10000,
  maxDepth: 16, timeoutMs: 30000,
})
const HARD_LIMITS = Object.freeze({
  maxBytes: 16777216, maxSources: 10000, maxClaims: 10000,
  maxCitations: 100000, maxSupportRelations: 100000,
  maxDepth: 64, timeoutMs: 3600000,
})

export function validateLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) throw new ConfigError('limits must be an object')
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${key}"`)
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) throw new ConfigError(`${key} must be a positive integer at most ${HARD_LIMITS[key]}`)
  }
  return { ...DEFAULT_LIMITS, ...overrides }
}

function utcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return null
  return time / 86400000
}

function deadline(now, timeoutMs) {
  if (typeof now !== 'function') throw new ConfigError('now must be a function')
  let start
  try { start = now() } catch { throw new ConfigError('now must return a finite number') }
  if (!Number.isFinite(start)) throw new ConfigError('now must return a finite number')
  return () => {
    let current
    try { current = now() } catch { throw new ConfigError('now must return a finite number') }
    if (!Number.isFinite(current)) throw new ConfigError('now must return a finite number')
    if (current - start > timeoutMs) throw new DeadlineExceeded()
  }
}

export const RULES = Object.freeze({
  'citation-unresolved': Object.freeze({ severity: 'error', incomplete: false }),
  'claim-uncovered': Object.freeze({ severity: 'error', incomplete: false }),
  'source-unapproved': Object.freeze({ severity: 'error', incomplete: false }),
  'permission-denied': Object.freeze({ severity: 'error', incomplete: false }),
  'source-stale': Object.freeze({ severity: 'error', incomplete: false }),
  'inventory-unknown': Object.freeze({ severity: 'warning', incomplete: true }),
  'approval-unknown': Object.freeze({ severity: 'warning', incomplete: true }),
  'permission-unknown': Object.freeze({ severity: 'warning', incomplete: true }),
  'freshness-unknown': Object.freeze({ severity: 'warning', incomplete: true }),
  'support-unknown': Object.freeze({ severity: 'warning', incomplete: true }),
  'input-invalid': Object.freeze({ severity: 'error', incomplete: true }),
  'input-unreadable': Object.freeze({ severity: 'error', incomplete: true }),
  'byte-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'source-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'claim-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'citation-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'support-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'depth-limit-exceeded': Object.freeze({ severity: 'error', incomplete: true }),
  'analysis-timeout': Object.freeze({ severity: 'error', incomplete: true }),
})

function finding(ruleId, pointer, message) {
  const rule = RULES[ruleId]
  if (rule === undefined) throw new Error(`Unknown rule: ${ruleId}`)
  return { ruleId, severity: rule.severity, message, location: { file: 'export', pointer } }
}

function outcome(findings) {
  if (findings.some((item) => RULES[item.ruleId].incomplete)) return 'incomplete'
  return findings.some((item) => item.severity === 'error') ? 'fail' : 'pass'
}

function ratio(numerator, denominator) { return { numerator, denominator } }

function incomplete(ruleId, pointer, message, scope, asOf, maxAgeDays) {
  return {
    schemaVersion: SCHEMA_VERSION, tool: TOOL_ID, status: 'incomplete',
    scope, asOf, maxAgeDays,
    coverage: {
      resolvedCitations: ratio(null, null), usableCitations: ratio(null, null), coveredClaims: ratio(null, null),
    },
    summary: { checked: 0, errors: 1, warnings: 0 },
    findings: [finding(ruleId, pointer, message)],
  }
}

function inspectExport(exported, limits, checkDeadline) {
  if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) return ['input-invalid', '', 'Export must be an object.']
  const pending = [{ value: exported, depth: 1 }]
  const active = new WeakSet()
  while (pending.length > 0) {
    checkDeadline()
    const { value, depth, leaving } = pending.pop()
    if (leaving) { active.delete(value); continue }
    if (depth > limits.maxDepth) return ['depth-limit-exceeded', '', `Export nesting exceeds ${limits.maxDepth}.`]
    if (value === null || typeof value !== 'object') continue
    if (active.has(value)) return ['input-invalid', '', 'Export has a cycle.']
    active.add(value)
    pending.push({ value, leaving: true })
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push({ value: child, depth: depth + 1 })
  }
  if (exported.schemaVersion !== SCHEMA_VERSION || !Array.isArray(exported.sources) || !Array.isArray(exported.claims)
    || exported.claims.length === 0
    || (exported.inventoryComplete !== true && exported.inventoryComplete !== false && exported.inventoryComplete !== undefined)) {
    return ['input-invalid', '', 'Export version, inventory flag, sources or claims are invalid.']
  }
  if (exported.sources.length > limits.maxSources) return ['source-limit-exceeded', '/sources', `Source count exceeds ${limits.maxSources}.`]
  if (exported.claims.length > limits.maxClaims) return ['claim-limit-exceeded', '/claims', `Claim count exceeds ${limits.maxClaims}.`]
  const validId = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  const sourceIds = new Set()
  let supportCount = 0
  for (const [index, source] of exported.sources.entries()) {
    checkDeadline()
    if (source === null || typeof source !== 'object' || Array.isArray(source) || !validId(source.id) || sourceIds.has(source.id)
      || (source.approved !== undefined && typeof source.approved !== 'boolean')
      || (source.permissions !== undefined && (!Array.isArray(source.permissions) || !source.permissions.every(validId)))
      || (source.observedAt !== undefined && typeof source.observedAt !== 'string')
      || (source.supportsClaims !== undefined && (!Array.isArray(source.supportsClaims) || !source.supportsClaims.every(validId)))) {
      return ['input-invalid', `/sources/${index}`, 'Source ID or declared metadata is invalid.']
    }
    sourceIds.add(source.id)
    if (source.supportsClaims !== undefined) supportCount += source.supportsClaims.length
    if (supportCount > limits.maxSupportRelations) return ['support-limit-exceeded', `/sources/${index}/supportsClaims`, `Support relation count exceeds ${limits.maxSupportRelations}.`]
  }
  const claimIds = new Set()
  let citations = 0
  for (const [index, claim] of exported.claims.entries()) {
    checkDeadline()
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim) || !validId(claim.id) || claimIds.has(claim.id)
      || !Array.isArray(claim.citations) || !claim.citations.every(validId)) {
      return ['input-invalid', `/claims/${index}`, 'Claim ID or citation list is invalid.']
    }
    claimIds.add(claim.id)
    citations += claim.citations.length
    if (citations > limits.maxCitations) return ['citation-limit-exceeded', `/claims/${index}/citations`, `Citation count exceeds ${limits.maxCitations}.`]
  }
  for (const [index, source] of exported.sources.entries()) {
    checkDeadline()
    if (source.supportsClaims?.some((id) => !claimIds.has(id))) return ['input-invalid', `/sources/${index}/supportsClaims`, 'A support relation names no declared claim.']
  }
  return null
}

function auditCore(exported, { scope, asOf, maxAgeDays, checkDeadline }) {
  const sources = new Map(exported.sources.map((item) => [item.id, item]))
  const findings = []
  if (exported.inventoryComplete !== true) {
    findings.push(finding('inventory-unknown', '/inventoryComplete', 'The source inventory is not declared complete, so absent IDs cannot be resolved.'))
  }
  let references = 0
  let resolved = 0
  let usable = 0
  let covered = 0
  let usableUnknown = false
  let coveredUnknown = false
  for (const [claimIndex, claim] of exported.claims.entries()) {
    checkDeadline()
    let supported = false
    let supportUnknown = false
    for (const [citationIndex, id] of claim.citations.entries()) {
      checkDeadline()
      references += 1
      const pointer = `/claims/${claimIndex}/citations/${citationIndex}`
      const source = sources.get(id)
      if (source === undefined) {
        if (exported.inventoryComplete === true) findings.push(finding('citation-unresolved', pointer, 'Citation ID does not occur in the declared-complete approved-source export.'))
        else supportUnknown = true
        continue
      }
      resolved += 1
      let usableHere = true
      let unknownHere = false
      if (typeof source.approved !== 'boolean') {
        findings.push(finding('approval-unknown', pointer, 'Source approval was not declared.'))
        unknownHere = true
      } else if (!source.approved) {
        findings.push(finding('source-unapproved', pointer, 'Cited source is not approved.'))
        usableHere = false
      }
      if (!Array.isArray(source.permissions)) {
        findings.push(finding('permission-unknown', pointer, 'Cited source has no declared permission scopes.'))
        unknownHere = true
      } else if (!source.permissions.includes(scope)) {
        findings.push(finding('permission-denied', pointer, 'Cited source does not permit the declared scope.'))
        usableHere = false
      }
      const observedDay = utcDay(source.observedAt)
      const age = observedDay === null ? null : utcDay(asOf) - observedDay
      if (age === null || age < 0) {
        findings.push(finding('freshness-unknown', pointer, 'Cited source freshness could not be determined at the declared date.'))
        unknownHere = true
      } else if (age > maxAgeDays) {
        findings.push(finding('source-stale', pointer, `Cited source age ${age} days exceeds the ${maxAgeDays}-day policy.`))
        usableHere = false
      }
      if (!Array.isArray(source.supportsClaims)) {
        findings.push(finding('support-unknown', pointer, 'Cited source has no declared claim-support relations.'))
        supportUnknown = true
      }
      if (unknownHere) {
        usableUnknown = true
        supportUnknown = true
      }
      if (usableHere && !unknownHere) {
        usable += 1
        if (source.supportsClaims?.includes(claim.id)) supported = true
      }
    }
    if (supported) covered += 1
    else if (supportUnknown) coveredUnknown = true
    else findings.push(finding('claim-uncovered', `/claims/${claimIndex}`, 'No cited, usable source explicitly supports this declared claim.'))
  }
  checkDeadline()
  findings.sort((a, b) => byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer, b.location.pointer) || byCodeUnit(a.ruleId, b.ruleId))
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status: outcome(findings),
    scope, asOf, maxAgeDays,
    coverage: {
      resolvedCitations: ratio(exported.inventoryComplete === true ? resolved : null, references),
      usableCitations: ratio(usableUnknown ? null : usable, references),
      coveredClaims: ratio(coveredUnknown ? null : covered, exported.claims.length),
    },
    summary: { checked: exported.claims.length, errors: findings.filter((item) => item.severity === 'error').length, warnings: findings.filter((item) => item.severity === 'warning').length },
    findings,
  }
}

export function auditCitations(exported, { scope, asOf, maxAgeDays = 30, limits: overrides, now = Date.now } = {}) {
  if (typeof scope !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(scope)) throw new ConfigError('scope must be a nonempty ASCII scope ID')
  if (utcDay(asOf) === null) throw new ConfigError('asOf must be a real YYYY-MM-DD UTC date')
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 36500) throw new ConfigError('maxAgeDays must be an integer from 0 to 36500')
  const limits = validateLimits(overrides)
  const checkDeadline = deadline(now, limits.timeoutMs)
  return auditWithDeadline(exported, { scope, asOf, maxAgeDays, limits, checkDeadline })
}

function auditWithDeadline(exported, options) {
  const { scope, asOf, maxAgeDays, limits, checkDeadline } = options
  try {
    const problem = inspectExport(exported, limits, checkDeadline)
    if (problem !== null) return incomplete(...problem, scope, asOf, maxAgeDays)
    return auditCore(exported, options)
  } catch (error) {
    if (!(error instanceof DeadlineExceeded)) throw error
    return incomplete('analysis-timeout', '', `Audit exceeded the ${limits.timeoutMs} ms time budget; no partial conclusion is published.`, scope, asOf, maxAgeDays)
  }
}

export async function auditFile(path, { scope, asOf, maxAgeDays = 30, limits: overrides, now = Date.now } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new ConfigError('input path is required')
  if (typeof scope !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(scope)) throw new ConfigError('scope must be a nonempty ASCII scope ID')
  if (utcDay(asOf) === null) throw new ConfigError('asOf must be a real YYYY-MM-DD UTC date')
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 36500) throw new ConfigError('maxAgeDays must be an integer from 0 to 36500')
  const limits = validateLimits(overrides)
  const checkDeadline = deadline(now, limits.timeoutMs)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    checkDeadline()
    if (!(await handle.stat()).isFile()) return incomplete('input-unreadable', '', 'Named input is not a regular file.', scope, asOf, maxAgeDays)
    const buffer = Buffer.alloc(limits.maxBytes + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null)
      checkDeadline()
      if (bytesRead === 0) break
      used += bytesRead
    }
    if (used > limits.maxBytes) return incomplete('byte-limit-exceeded', '', `Input exceeds ${limits.maxBytes} bytes.`, scope, asOf, maxAgeDays)
    let exported
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))
      exported = JSON.parse(text)
      if (hasDuplicateObjectKeys(text)) return incomplete('input-invalid', '', 'Input has duplicate JSON keys.', scope, asOf, maxAgeDays)
    } catch {
      return incomplete('input-invalid', '', 'Input is not valid UTF-8 JSON.', scope, asOf, maxAgeDays)
    }
    checkDeadline()
    return auditWithDeadline(exported, { scope, asOf, maxAgeDays, limits, checkDeadline })
  } catch (error) {
    if (error instanceof DeadlineExceeded) return incomplete('analysis-timeout', '', `Audit exceeded the ${limits.timeoutMs} ms time budget; no partial conclusion is published.`, scope, asOf, maxAgeDays)
    if (error instanceof ConfigError) throw error
    return incomplete('input-unreadable', '', 'Named input could not be read.', scope, asOf, maxAgeDays)
  } finally {
    await handle?.close()
  }
}

export const renderReport = (report) => `${JSON.stringify(report, null, 2)}\n`
export const exitCodeFor = (report) => (report.status === 'incomplete' ? 2 : report.status === 'fail' ? 1 : 0)
