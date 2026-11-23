import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_LIMITS, loadLimits, validateLimits } from '../src/limits.mjs'

const root = mkdtempSync(join(tmpdir(), 'android-limits-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

test('missing file means defaults and no warnings', () => {
  const { limits, warnings, file } = loadLimits(root)
  assert.deepEqual(limits, DEFAULT_LIMITS)
  assert.deepEqual(warnings, [])
  assert.equal(file, null)
})

test('a valid file overrides every knob', () => {
  writeFileSync(join(root, 'limits.json'), JSON.stringify({ waitMs: 300_000, maxQueue: 5, timeoutMs: 1_800_000, nice: 10, cpus: '0-3,6' }))
  const { limits, warnings } = loadLimits(root)
  assert.deepEqual(limits, { waitMs: 300_000, maxQueue: 5, timeoutMs: 1_800_000, nice: 10, cpus: '0-3,6' })
  assert.deepEqual(warnings, [])
})

test('invalid values fall back to the default and explain why', () => {
  const { limits, warnings } = validateLimits({ waitMs: 10, maxQueue: 99, timeoutMs: 'soon', nice: 42, cpus: 'cpu', extra: 1 })
  assert.deepEqual(limits, DEFAULT_LIMITS)
  assert.equal(warnings.length, 6)
  assert.ok(warnings.some((line) => line.startsWith('waitMs:')))
  assert.ok(warnings.some((line) => line.startsWith('timeoutMs:')))
  assert.ok(warnings.some((line) => line.startsWith('extra:')))
})

test('cpus accepts an empty string to disable pinning', () => {
  const { limits } = validateLimits({ cpus: '' })
  assert.equal(limits.cpus, '')
})

test('an unparsable file keeps defaults and warns', () => {
  writeFileSync(join(root, 'limits.json'), '{ not json')
  const { limits, warnings } = loadLimits(root)
  assert.deepEqual(limits, DEFAULT_LIMITS)
  assert.match(warnings[0], /cannot parse/)
})

test('DSH_ANDROID_LIMITS points at another file', () => {
  const file = join(root, 'other.json')
  writeFileSync(file, JSON.stringify({ maxQueue: 0 }))
  const { limits, file: used } = loadLimits(root, { DSH_ANDROID_LIMITS: file })
  assert.equal(limits.maxQueue, 0)
  assert.equal(used, file)
})
