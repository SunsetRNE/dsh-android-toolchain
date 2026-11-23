import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXIT_BUSY, runInSlot } from '../src/slot.mjs'

const root = mkdtempSync(join(tmpdir(), 'android-slot-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

const options = { root, cpus: '', nice: '' }

test('serializes two callers through one slot', async () => {
  const startedAt = Date.now()
  const results = await Promise.all([
    runInSlot({ ...options, cmd: 'sh', args: ['-c', 'sleep 0.4; echo first'], owner: 't1', waitMs: 10_000 }),
    runInSlot({ ...options, cmd: 'sh', args: ['-c', 'sleep 0.4; echo second'], owner: 't2', waitMs: 10_000 }),
  ])
  const elapsed = Date.now() - startedAt
  assert.equal(results.filter((result) => result.ok).length, 2)
  assert.match(results.map((result) => result.stdout.trim()).sort().join(','), /first,second/)
  // Two 0.4 s jobs must take at least ~0.8 s when serialized.
  assert.ok(elapsed >= 750, `expected serialized runs (>=750ms), got ${elapsed}ms`)
})

test('a busy slot fails fast instead of piling up', async () => {
  const running = runInSlot({ ...options, cmd: 'sh', args: ['-c', 'sleep 1.5'], owner: 'holder', waitMs: 10_000 })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const blocked = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'echo nope'], owner: 'waiter', waitMs: 300 })
  assert.equal(blocked.busy, true)
  assert.equal(blocked.exitCode, EXIT_BUSY)
  const held = await running
  assert.equal(held.ok, true)
})

test('the queue cap refuses new waiters', async () => {
  const blocked = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'echo nope'], owner: 'q', maxQueue: 0 })
  assert.equal(blocked.busy, true)
  assert.equal(blocked.exitCode, EXIT_BUSY)
})

test('a hung build is killed at the wall-clock cap', async () => {
  const result = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'sleep 5'], owner: 't', timeoutMs: 300, waitMs: 10_000 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, 124)
})

test('a crashing command reports its exit code', async () => {
  const result = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'echo boom >&2; exit 7'], owner: 't', waitMs: 10_000 })
  assert.equal(result.exitCode, 7)
  assert.match(result.stderr, /boom/)
})
