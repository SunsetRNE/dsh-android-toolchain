/**
 * The single build slot.
 *
 * One slot, not N, because the device has ~1 GB of usable memory and a little
 * over 9 GB of swap already in use: a second JVM is an OOM, not a speedup.
 * The lock is a file lock (`flock`) so it holds across processes: the MCP
 * client probes and serves the broker in separate processes, subagents may run
 * their own broker instance, and the plain CLI writes to the same lock.
 *
 * Limits applied to the child: nice 19, pinned CPUs, wall-clock timeout.
 * NOTE: no RLIMIT_AS — the JVM reserves large virtual address space and would
 * fail to start; heap is capped with -Xmx by the launchers instead.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPaths } from './paths.mjs'
import { appendHistory } from './history.mjs'

export const EXIT_BUSY = 75

const HOLDER = fileURLToPath(new URL('./slot-holder.mjs', import.meta.url))

/** Defaults for every build. Overridable per call and by the manifest. */
export const LIMITS = {
  /** How long one caller may wait for the slot before failing fast. */
  waitMs: 120_000,
  /** How many callers may wait behind the holder. Beyond this, fail fast. */
  maxQueue: 3,
  /** Hard wall-clock cap for a single build. */
  timeoutMs: 1_200_000,
  /** Background-friendly priority. */
  nice: 19,
  /** Leave the first cores for the UI. Set to '' to disable. */
  cpus: '0-3',
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function pruneQueue(dir) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const file = join(dir, name)
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8'))
      if (!alive(Number(entry.pid))) rmSync(file, { force: true })
    } catch {
      rmSync(file, { force: true })
    }
  }
}

/** Current holder plus live waiters; safe to call while a build runs. */
export function readSlotState(root) {
  const paths = runPaths(root)
  let holder = null
  try {
    holder = JSON.parse(readFileSync(paths.holder, 'utf8'))
  } catch {}
  const queue = []
  try {
    for (const name of readdirSync(paths.queue)) {
      try {
        const entry = JSON.parse(readFileSync(join(paths.queue, name), 'utf8'))
        if (alive(Number(entry.pid))) queue.push(entry)
      } catch {}
    }
  } catch {}
  return { holder, queue, limits: LIMITS }
}

/**
 * Run one command under the single slot.
 * @returns {{ok: boolean, busy?: boolean, exitCode: number, timedOut?: boolean,
 *   waitedMs?: number, durationMs?: number, stdout: string, stderr: string,
 *   reason?: string}}
 */
export async function runInSlot({
  root,
  cmd,
  args = [],
  cwd,
  env,
  owner = 'unknown',
  timeoutMs,
  waitMs,
  maxQueue,
  nice,
  cpus,
}) {
  const paths = runPaths(root)
  mkdirSync(paths.queue, { recursive: true })
  pruneQueue(paths.queue)

  const id = `${Date.now().toString(36)}-${process.pid}`
  const startedIso = new Date().toISOString()
  const startedMs = Date.now()
  const label = [cmd, ...args].join(' ').slice(0, 200)
  const done = (outcome, status) => {
    appendHistory(root, {
      id,
      kind: 'build',
      owner,
      cmd: label,
      cwd: cwd ?? process.cwd(),
      startedAt: startedIso,
      finishedAt: new Date().toISOString(),
      waitedMs: outcome.waitedMs,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      status,
      ...(outcome.timedOut ? { timedOut: true } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
    return { ...outcome, id }
  }

  const queueLimit = maxQueue ?? LIMITS.maxQueue
  const waiting = readdirSync(paths.queue).length
  if (waiting >= queueLimit) {
    return done({
      ok: false,
      busy: true,
      exitCode: EXIT_BUSY,
      reason: `slot queue full (${waiting}/${queueLimit}); retry when android_status() is idle`,
      stdout: '',
      stderr: '',
    }, 'queue-full')
  }

  const entry = join(paths.queue, `${process.pid}-${Date.now()}.json`)
  writeFileSync(entry, JSON.stringify({ pid: process.pid, owner, since: new Date().toISOString() }))

  const resultFile = join(paths.runDir, `result-${process.pid}-${Date.now()}.json`)
  const waitSeconds = Math.ceil((waitMs ?? LIMITS.waitMs) / 1000)
  const holderArgs = [
    process.execPath,
    HOLDER,
    '--holder', paths.holder,
    '--result', resultFile,
    '--queue-entry', entry,
    '--owner', owner,
    '--timeout', String(timeoutMs ?? LIMITS.timeoutMs),
    '--nice', String(nice ?? LIMITS.nice),
    '--cpus', cpus ?? LIMITS.cpus,
    '--cwd', cwd ?? process.cwd(),
    '--',
    cmd,
    ...args,
  ]

  let flockStderr = ''
  const code = await new Promise((resolve) => {
    const child = spawn('flock', ['-w', String(waitSeconds), '-E', String(EXIT_BUSY), paths.lock, ...holderArgs], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: env ?? process.env,
    })
    child.stderr.on('data', (chunk) => {
      if (flockStderr.length < 8192) flockStderr += chunk.toString()
    })
    child.on('error', () => resolve(127))
    child.on('close', (exitCode) => resolve(exitCode === null ? 1 : exitCode))
  })

  rmSync(entry, { force: true })
  // holder.json belongs to the running build (written by the holder, removed by
  // its finish()); a failed/busy caller must not erase someone else's metadata.

  let result = null
  try {
    result = JSON.parse(readFileSync(resultFile, 'utf8'))
  } catch {}
  rmSync(resultFile, { force: true })

  if (!result) {
    if (code === EXIT_BUSY) {
      return done({
        ok: false,
        busy: true,
        exitCode: code,
        reason: `slot busy: no turn within ${waitSeconds}s`,
        waitedMs: Date.now() - startedMs,
        durationMs: 0,
        stdout: '',
        stderr: flockStderr.trim(),
      }, 'busy')
    }
    return done({
      ok: false,
      exitCode: code,
      reason: 'slot holder produced no result',
      waitedMs: Date.now() - startedMs,
      stdout: '',
      stderr: flockStderr.trim(),
    }, 'error')
  }

  return done({
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    waitedMs: result.startedAt ? Date.parse(result.startedAt) - startedMs : undefined,
    durationMs: result.durationMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }, result.exitCode === 0 ? 'ok' : result.timedOut ? 'timeout' : 'failed')
}
