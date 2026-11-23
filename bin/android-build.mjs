#!/usr/bin/env node
/**
 * Non-agent entry point: `android-build [task...] [--cwd DIR] [--timeout ms]`.
 * Same slot and limits as the MCP tool, so cron jobs and other apps queue
 * behind agent builds instead of racing them.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { aapt2Override, binPath, resolveRoot, sdkRoot } from '../src/paths.mjs'
import { runInSlot } from '../src/slot.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const [, val] = argv.splice(index, 2)
  return val
}

const cwd = value('--cwd')
const timeoutMs = Number(value('--timeout') ?? '')
const waitMs = Number(value('--wait') ?? '')
const owner = value('--owner') ?? `cli:${process.pid}`
const tasks = argv.length ? argv : ['build']

const root = resolveRoot({})
const gradle = binPath(root, 'gradle')
if (!existsSync(gradle)) {
  console.error(`[android-build] gradle is not provisioned under ${root}; run android-provision`)
  process.exit(1)
}

const path = [join(root, 'bin'), process.env.PATH ?? ''].filter(Boolean).join(':')
const env = {
  ...process.env,
  PATH: path,
  JAVA_HOME: join(root, 'jdk', 'current'),
  GRADLE_USER_HOME: join(root, 'gradle-home'),
}
const sdk = sdkRoot(root)
if (sdk) {
  env.ANDROID_HOME = sdk
  env.ANDROID_SDK_ROOT = sdk
}
// AGP always resolves aapt2 from Google Maven (x86_64 only). On aarch64 the
// setup script installs an arm64 build; hand it over unless the caller did.
const override = aapt2Override(root)
const hasOverride = tasks.some((task) => task.startsWith('-Pandroid.aapt2FromMavenOverride='))
if (override && !hasOverride) tasks.push(`-Pandroid.aapt2FromMavenOverride=${override}`)

const result = await runInSlot({
  root,
  cmd: gradle,
  args: tasks,
  cwd: cwd ?? process.cwd(),
  env,
  owner,
  timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : undefined,
})

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.busy || result.reason) console.error(`[android-build] ${result.reason ?? 'busy'}`)
console.error(`[android-build] exit ${result.exitCode} in ${Math.round((result.durationMs ?? 0) / 1000)}s`)
process.exit(result.exitCode ?? 1)
