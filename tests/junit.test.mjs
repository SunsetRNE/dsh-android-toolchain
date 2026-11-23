import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findResultFiles, summarize } from '../src/junit.mjs'

const project = mkdtempSync(join(tmpdir(), 'android-junit-'))
test.after(() => rmSync(project, { recursive: true, force: true }))

function writeResult(relative, xml) {
  const file = join(project, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, xml)
}

test('summarizes counts and failing cases from JUnit XML', () => {
  writeResult(
    'app/build/test-results/testDebugUnitTest/TEST-com.example.A.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.A" tests="3" failures="1" errors="0" skipped="1">
  <testcase classname="com.example.A" name="passes"/>
  <testcase classname="com.example.A" name="fails">
    <failure message="expected &lt;1&gt; but was &lt;2&gt;">stack trace</failure>
  </testcase>
  <testcase classname="com.example.A" name="skipped"><skipped/></testcase>
</testsuite>`,
  )
  writeResult(
    'build/test-results/test/TEST-com.example.B.xml',
    `<testsuite name="com.example.B" tests="2" failures="0" errors="1" skipped="0">
  <testcase classname="com.example.B" name="boom"><error message="NPE"/></testcase>
  <testcase classname="com.example.B" name="ok"/>
</testsuite>`,
  )
  // A decoy inside node_modules must be ignored.
  writeResult('node_modules/pkg/build/test-results/test/TEST-ignored.xml', '<testsuite tests="99" failures="99"/>')

  const files = findResultFiles(project)
  assert.equal(files.length, 2)

  const summary = summarize(project)
  assert.deepEqual(
    { tests: summary.tests, failures: summary.failures, errors: summary.errors, skipped: summary.skipped },
    { tests: 5, failures: 1, errors: 1, skipped: 1 },
  )
  assert.equal(summary.failing.length, 2)
  const failure = summary.failing.find((entry) => entry.test === 'fails')
  assert.equal(failure.kind, 'failure')
  assert.equal(failure.message, 'expected <1> but was <2>')
  const error = summary.failing.find((entry) => entry.test === 'boom')
  assert.equal(error.kind, 'error')
  assert.equal(error.message, 'NPE')
})

test('a project without results reports zeros instead of throwing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'android-empty-'))
  try {
    const summary = summarize(empty)
    assert.equal(summary.files, 0)
    assert.equal(summary.tests, 0)
    assert.deepEqual(summary.failing, [])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
