import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { GUIDE_TOPICS, loadGuide, parseGuide } from '../src/guide.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('the packaged guide exposes every documented topic', () => {
  const guide = loadGuide(root, 'build')
  assert.equal(guide.topic, 'build')
  assert.deepEqual(guide.topics.sort(), [...GUIDE_TOPICS].sort())
  assert.match(guide.text, /android_build/)
  assert.match(guide.text, /busy/)
  assert.ok(existsSync(guide.docs))
  for (const topic of GUIDE_TOPICS) {
    const entry = loadGuide(root, topic)
    assert.equal(entry.topic, topic)
    assert.ok(entry.text.length > 20, `${topic} should have real content`)
  }
})

test('an unknown or empty topic falls back to the overview and lists topics', () => {
  const unknown = loadGuide(root, 'nope')
  assert.equal(unknown.topic, null)
  assert.equal(unknown.requested, 'nope')
  assert.match(unknown.note, /unknown topic/)
  assert.match(unknown.text, /单槽|slot/)
  assert.ok(unknown.topics.includes('build'))

  const empty = loadGuide(root)
  assert.equal(empty.topic, 'overview')
})

test('parsing ignores prose outside known topics and keeps dots inside a topic', () => {
  const topics = parseGuide('# title\ntext before\n## build\nline one\n## BAD topic!\n## sign\nline two')
  assert.deepEqual(topics, { build: 'line one', sign: 'line two' })
})
