import assert from 'node:assert/strict'
import test from 'node:test'
import { loadManifest, validateManifest } from '../src/manifest.mjs'

test('the manifest has a valid shape', () => {
  const manifest = loadManifest()
  const { problems } = validateManifest(manifest, { strict: false })
  assert.deepEqual(problems, [])
  assert.ok(manifest.components.jdk, 'jdk component is declared')
  assert.ok(manifest.components.gradle, 'gradle component is declared')
})

test('strict validation demands a pin for every enabled component', () => {
  const manifest = loadManifest()
  const enabled = Object.entries(manifest.components).filter(([, spec]) => spec.enabled)
  const unpinned = enabled.filter(([, spec]) => !/^[0-9a-f]{64}$/.test(spec.sha256 ?? ''))
  const { problems, warnings } = validateManifest(manifest, { strict: true })
  assert.equal(problems.length, unpinned.length)
  assert.deepEqual(warnings, [])
})
