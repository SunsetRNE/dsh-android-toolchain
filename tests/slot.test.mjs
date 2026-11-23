import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXIT_BUSY, readSlotState, runInSlot } from '../src/slot.mjs'

const root = mkdtempSync(join(tmpdir(), 'android-slot-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

const options = { root, cpus: '', nice: '' }

/** Poll for a holder: spawn latency is load-dependent, especially on a phone. */
async function waitForHolder(root, owner, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readSlotState(root)
    if (state.holder?.owner === owner) return state.holder
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`holder "${owner}" did not appear within ${timeoutMs}ms`)
}

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
  const running = runInSlot({ ...options, cmd: 'sh', args: ['-c', 'sleep 2; echo held'], owner: 'holder', waitMs: 20_000 })
  await waitForHolder(root, 'holder')
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
  const result = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'sleep 5'], owner: 't', timeoutMs: 300, waitMs: 20_000 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, 124)
})

test('a crashing command reports its exit code', async () => {
  const result = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'echo boom >&2; exit 7'], owner: 't', waitMs: 20_000 })
  assert.equal(result.exitCode, 7)
  assert.match(result.stderr, /boom/)
})

test('a waiting caller does not erase the running build metadata', async () => {
  const running = runInSlot({ ...options, cmd: 'sh', args: ['-c', 'sleep 3'], owner: 'holder', waitMs: 20_000 })
  await waitForHolder(root, 'holder')

  const blocked = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'true'], owner: 'waiter', waitMs: 300 })
  assert.equal(blocked.busy, true)
  assert.equal(readSlotState(root).holder.owner, 'holder', 'busy attempt kept the holder metadata')
  assert.deepEqual(readSlotState(root).queue, [], 'the running build is not a waiter')

  await running
})

test('two roots build in parallel instead of queueing', async () => {
  // Each root owns its lock, so a second toolchain is a second slot. Overlap is
  // measured from timestamps written inside the jobs: wall-clock thresholds
  // would be load-dependent on a phone.
  const second = mkdtempSync(join(tmpdir(), 'android-slot-b-'))
  const log = join(root, 'parallel.log')
  const probe = join(root, 'probe.mjs')
  writeFileSync(
    probe,
    [
      "import { appendFileSync } from 'node:fs'",
      'const [file, label] = process.argv.slice(2)',
      'const write = (event) => appendFileSync(file, `${event} ${label} ${Date.now()}\\n`)',
      "write('start')",
      "setTimeout(() => { write('end') }, 800)",
      '',
    ].join('\n'),
  )

  try {
    const results = await Promise.all([
      runInSlot({ ...options, cmd: process.execPath, args: [probe, log, 'a'], owner: 'root-a', waitMs: 20_000 }),
      runInSlot({ ...options, root: second, cmd: process.execPath, args: [probe, log, 'b'], owner: 'root-b', waitMs: 20_000 }),
    ])
    assert.equal(results.filter((result) => result.ok).length, 2)

    const spans = new Map()
    for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      const [event, label, at] = line.split(' ')
      const span = spans.get(label) ?? {}
      span[event] = Number(at)
      spans.set(label, span)
    }
    const a = spans.get('a')
    const b = spans.get('b')
    assert.ok(a?.start && a?.end && b?.start && b?.end, 'both jobs recorded a full span')
    const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start)
    assert.ok(overlap > 300, `expected overlapping slots (>300ms), got ${overlap}ms`)

    assert.equal(readSlotState(root).holder, null)
    assert.equal(readSlotState(second).holder, null)
  } finally {
    rmSync(second, { recursive: true, force: true })
  }
})
