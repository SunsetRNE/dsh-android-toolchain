#!/usr/bin/env node
/**
 * `android-test [tasks...] [--cwd DIR] [--root ROOT] [--timeout ms] [--wait ms]`
 *
 * Runs Gradle's test task through a single slot and reads the JUnit XML it
 * writes, so callers get pass/fail counts and failing test names without
 * scraping Gradle's console output. Exit code is Gradle's.
 */
import { existsSync } from 'node:fs'
import { binPath, resolveRoot } from '../src/paths.mjs'
import { buildEnv, withAapt2Override } from '../src/env.mjs'
import { runInSlot } from '../src/slot.mjs'
import { summarize } from '../src/junit.mjs'
import { resolveRootRef } from '../src/roots.mjs'
import { failureHints } from '../src/hints.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const [, val] = argv.splice(index, 2)
  return val
}

const cwd = value('--cwd') ?? process.cwd()
const rootRef = value('--root')
const timeoutMs = Number(value('--timeout') ?? '')
const waitMs = Number(value('--wait') ?? '')
const owner = value('--owner') ?? `test:${process.pid}`
const tasks = argv.length ? argv : ['test']

let root
try {
  root = resolveRootRef(rootRef, { primary: resolveRoot({}) })
} catch (error) {
  console.error(`[android-test] ${error.message}`)
  process.exit(1)
}

const gradle = binPath(root, 'gradle')
if (!existsSync(gradle)) {
  console.error(`[android-test] gradle is not provisioned under ${root}; run android-provision`)
  process.exit(1)
}

const result = await runInSlot({
  root,
  cmd: gradle,
  args: withAapt2Override(root, tasks),
  cwd,
  env: buildEnv(root),
  owner,
  timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : undefined,
})

const summary = result.busy || result.exitCode === undefined ? null : summarize(cwd)
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
console.error(
  `[android-test] ${result.id ?? '-'} exit ${result.exitCode} in ${Math.round((result.durationMs ?? 0) / 1000)}s` +
    (summary ? ` tests=${summary.tests} failures=${summary.failures} errors=${summary.errors} skipped=${summary.skipped}` : ' (did not run)'),
)
if (!result.ok) {
  for (const hint of failureHints(`${result.stdout}\n${result.stderr}`)) console.error(`[android-test] hint: ${hint}`)
}
if (summary) {
  for (const failure of summary.failing) {
    console.error(`[android-test] FAIL ${failure.classname || failure.suite} > ${failure.test}: ${failure.message.split('\n')[0]}`)
  }
}
console.log(JSON.stringify({ buildId: result.id, exitCode: result.exitCode, busy: Boolean(result.busy), root, summary }, null, 2))
process.exit(result.exitCode ?? 1)
