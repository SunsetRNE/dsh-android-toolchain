#!/usr/bin/env node
/**
 * Non-agent entry point: `android-build [task...] [--cwd DIR] [--root ROOT]`.
 * Same slot and limits as the MCP tool, so cron jobs and other apps queue
 * behind agent builds instead of racing them.
 *
 * `--root` picks a registered root (by label) or an absolute path. Roots have
 * separate locks and limits, so two roots can build at the same time.
 */
import { existsSync } from 'node:fs'
import { binPath, resolveRoot } from '../src/paths.mjs'
import { buildEnv, withAapt2Override } from '../src/env.mjs'
import { runInSlot } from '../src/slot.mjs'
import { resolveRootRef } from '../src/roots.mjs'
import { failureHints } from '../src/hints.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const [, val] = argv.splice(index, 2)
  return val
}

const cwd = value('--cwd')
const rootRef = value('--root')
const timeoutMs = Number(value('--timeout') ?? '')
const waitMs = Number(value('--wait') ?? '')
const owner = value('--owner') ?? `cli:${process.pid}`
const tasks = argv.length ? argv : ['build']

let root
try {
  root = resolveRootRef(rootRef, { primary: resolveRoot({}) })
} catch (error) {
  console.error(`[android-build] ${error.message}`)
  process.exit(1)
}

const gradle = binPath(root, 'gradle')
if (!existsSync(gradle)) {
  console.error(`[android-build] gradle is not provisioned under ${root}; run android-provision`)
  process.exit(1)
}

const result = await runInSlot({
  root,
  cmd: gradle,
  args: withAapt2Override(root, tasks),
  cwd: cwd ?? process.cwd(),
  env: buildEnv(root),
  owner,
  timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : undefined,
})

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.busy || result.reason) console.error(`[android-build] ${result.reason ?? 'busy'}`)
if (!result.ok) {
  for (const hint of failureHints(`${result.stdout}\n${result.stderr}`)) console.error(`[android-build] hint: ${hint}`)
}
console.error(`[android-build] ${result.id ?? '-'} exit ${result.exitCode} in ${Math.round((result.durationMs ?? 0) / 1000)}s`)
process.exit(result.exitCode ?? 1)
