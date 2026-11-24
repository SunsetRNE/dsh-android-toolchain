import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { doctor, measureCache } from '../src/doctor.mjs'

const root = mkdtempSync(join(tmpdir(), 'android-doctor-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

function writeSized(file, bytes) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes))
}

test('cache measurement finds reclaimable data and stale versions', () => {
  writeSized(join(root, 'tmp', 'archive.tar.gz'), 1024 * 1024)
  writeSized(join(root, 'jdk', '17', 'bin', 'java'), 512 * 1024)
  writeSized(join(root, 'jdk', '21', 'bin', 'java'), 256 * 1024)
  symlinkSync('21', join(root, 'jdk', 'current'))

  const report = measureCache(root)
  assert.ok(report.totalBytes >= 1024 * 1024, 'reports the measured total')
  assert.ok(report.entries.some((entry) => entry.kind === 'downloads' && entry.safe), 'tmp is safe to remove')
  assert.ok(
    report.staleVersions.some((entry) => entry.component === 'jdk' && entry.version === '17'),
    'a non-current JDK version is stale',
  )
  assert.ok(
    !report.staleVersions.some((entry) => entry.version === '21'),
    'the version current points at is not stale',
  )
  assert.ok(report.reclaimableBytes >= 1024 * 1024)
  assert.ok(report.suggestions.some((line) => line.includes('rm -rf')))
})

test('doctor measures on demand and reuses the report afterwards', () => {
  const live = doctor({ root, cache: true })
  assert.equal(live.cache.source, 'live')
  assert.ok(live.cache.totalBytes > 0)

  const stored = JSON.parse(readFileSync(join(root, 'run', 'cache-report.json'), 'utf8'))
  assert.ok(stored.totalBytes > 0)

  const reused = doctor({ root })
  assert.equal(reused.cache.source, 'cached')
  assert.equal(reused.cache.totalBytes, live.cache.totalBytes)
})

test('without a report doctor stays cheap and says how to get one', () => {
  const cold = mkdtempSync(join(tmpdir(), 'android-doctor-cold-'))
  try {
    const report = doctor({ root: cold })
    assert.equal(report.cache.source, 'missing')
    assert.match(report.cache.note, /--cache/)
  } finally {
    rmSync(cold, { recursive: true, force: true })
  }
})
