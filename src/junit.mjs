/**
 * Minimal JUnit XML reader for `android_test`.
 *
 * Gradle writes JUnit XML under `build/test-results/<task>/TEST-*.xml`. We parse
 * just enough to answer "how many passed, which failed, why" without pulling an
 * XML dependency into a tool that must stay installable offline.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DEPTH = 7
const MAX_FILES = 400

/** All `build/test-results/**\/*.xml` files under a project directory. */
export function findResultFiles(projectDir) {
  const files = []
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || name === '.gradle') continue
      const path = join(dir, name)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue
      if (name === 'test-results') {
        collectXml(path, files)
        continue
      }
      walk(path, depth + 1)
    }
  }
  walk(projectDir, 0)
  return files.sort()
}

function collectXml(dir, into) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (into.length >= MAX_FILES) return
    const path = join(dir, name)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (stats.isDirectory()) collectXml(path, into)
    else if (name.endsWith('.xml')) into.push(path)
  }
}

function attr(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return match ? decode(match[1]) : ''
}

function decode(text) {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/** Parse one JUnit XML document. */
export function parseJUnitFile(file) {
  let xml
  try {
    xml = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const suiteMatch = /<testsuite\b[^>]*>/.exec(xml)
  const suite = suiteMatch ? attr(suiteMatch[0], 'name') : ''

  let tests = 0
  let failures = 0
  let errors = 0
  let skipped = 0
  for (const tag of xml.match(/<testsuite\b[^>]*>/g) ?? []) {
    tests += Number(attr(tag, 'tests') || 0)
    failures += Number(attr(tag, 'failures') || 0)
    errors += Number(attr(tag, 'errors') || 0)
    skipped += Number(attr(tag, 'skipped') || 0)
  }

  const failing = []
  const cases = xml.split('<testcase').slice(1)
  for (const chunk of cases) {
    const head = chunk.slice(0, chunk.indexOf('>') + 1)
    const end = chunk.indexOf('</testcase>')
    const body = end >= 0 ? chunk.slice(0, end) : ''
    const problem = /<(failure|error)\b[^>]*>/.exec(body)
    if (!problem) continue
    failing.push({
      suite,
      test: attr(head, 'name'),
      classname: attr(head, 'classname'),
      kind: problem[1],
      message: (attr(problem[0], 'message') || problem[1]).slice(0, 500),
    })
  }
  if (tests === 0) tests = cases.length
  return { file, tests, failures, errors, skipped, failing }
}

/** Aggregate every result file under the project. */
export function summarize(projectDir) {
  const files = findResultFiles(projectDir)
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 }
  const failing = []
  for (const file of files) {
    const parsed = parseJUnitFile(file)
    if (!parsed) continue
    totals.tests += parsed.tests
    totals.failures += parsed.failures
    totals.errors += parsed.errors
    totals.skipped += parsed.skipped
    failing.push(...parsed.failing)
  }
  return { files: files.length, ...totals, failing: failing.slice(0, 20) }
}
