import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HISTORY_LIMIT, appendHistory, historyPath, readHistory } from '../src/history.mjs'
import { runInSlot } from '../src/slot.mjs'

const root = mkdtempSync(join(tmpdir(), 'android-history-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

const options = { root, cpus: '', nice: '' }

test('every executed build is recorded with an id and a status', async () => {
  const first = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'echo one'], owner: 'alice', waitMs: 10_000 })
  const second = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'exit 3'], owner: 'bob', waitMs: 10_000 })
  assert.match(first.id, /^[a-z0-9]+-\d+$/)
  assert.equal(second.exitCode, 3)

  const history = readHistory(root, 10)
  assert.equal(history.length, 2)
  assert.deepEqual(history.map((entry) => entry.owner), ['alice', 'bob'])
  assert.deepEqual(history.map((entry) => entry.status), ['ok', 'failed'])
  assert.equal(history[0].id, first.id)
  assert.equal(history[1].exitCode, 3)
})

test('a refused queue is recorded, not lost', async () => {
  const refused = await runInSlot({ ...options, cmd: 'sh', args: ['-c', 'true'], owner: 'carol', maxQueue: 0 })
  assert.equal(refused.busy, true)
  const last = readHistory(root, 1)[0]
  assert.equal(last.status, 'queue-full')
  assert.equal(last.owner, 'carol')
})

test('the log is trimmed to the newest entries once it grows past the cap', () => {
  const file = historyPath(root)
  const padding = 'x'.repeat(4000)
  const lines = []
  for (let index = 0; index < 200; index += 1) lines.push(JSON.stringify({ id: `old-${index}`, padding }))
  writeFileSync(file, `${lines.join('\n')}\n`)
  appendHistory(root, { id: 'newest', status: 'ok' })
  const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.ok(kept.length <= HISTORY_LIMIT, `expected <= ${HISTORY_LIMIT} lines, got ${kept.length}`)
  assert.match(kept[kept.length - 1], /newest/)
})
