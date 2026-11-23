#!/usr/bin/env node
/**
 * Runs *inside* the flock-held slot: publishes holder metadata, runs the
 * command with nice/taskset/timeout, buffers output, and writes the result to
 * a file.
 *
 * It must never write to stdout: the broker's stdout is the MCP JSON-RPC
 * channel, and a stray line corrupts the stream.
 */
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const take = (flag, fallback) => {
  const index = argv.indexOf(flag)
  if (index < 0) return fallback
  const value = argv[index + 1]
  argv.splice(index, 2)
  return value
}

const holderPath = take('--holder')
const resultPath = take('--result')
const queueEntry = take('--queue-entry')
const owner = take('--owner', 'unknown')
const timeoutMs = Number(take('--timeout', '1200000'))
const nice = take('--nice', '19')
const cpus = take('--cpus', '0-3')
const cwd = take('--cwd', process.cwd())
const separator = argv.indexOf('--')
const cmd = argv[separator + 1]
const cmdArgs = argv.slice(separator + 2)

if (!resultPath || !cmd) {
  console.error('slot-holder: missing --result or command')
  process.exit(64)
}

// Holding the lock means this caller is no longer waiting.
if (queueEntry) rmSync(queueEntry, { force: true })

const startedAt = new Date().toISOString()
writeFileSync(
  holderPath,
  JSON.stringify({ pid: process.pid, owner, cmd: [cmd, ...cmdArgs].join(' '), startedAt }, null, 2),
)

const prefix = []
if (cpus) prefix.push('taskset', '-c', cpus)
if (nice) prefix.push('nice', '-n', String(nice))

const cap = 1 << 20 // 1 MiB per stream, surfaced truncated by the broker
let stdout = ''
let stderr = ''
let truncated = false
const collect = (chunk, append) => {
  const text = chunk.toString()
  if (text.length + append.length <= cap) return append + text
  truncated = true
  return (append + text).slice(-cap)
}

let timedOut = false
const startedMs = Date.now()

const child = prefix.length
  ? spawn(prefix[0], [...prefix.slice(1), cmd, ...cmdArgs], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  : spawn(cmd, cmdArgs, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })

const killTree = () => {
  // Kill the whole process group: a shell wrapper can leave a grandchild
  // (gradle, sleep) holding the pipes after the direct child dies.
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

const timer = timeoutMs > 0
  ? setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
  : undefined

child.stdout.on('data', (chunk) => {
  stdout = collect(chunk, stdout)
})
child.stderr.on('data', (chunk) => {
  stderr = collect(chunk, stderr)
})

const finish = (exitCode, extra = {}) => {
  clearTimeout(timer)
  writeFileSync(
    resultPath,
    JSON.stringify({
      exitCode,
      timedOut,
      truncated,
      stdout,
      stderr,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      ...extra,
    }),
  )
  rmSync(holderPath, { force: true })
  process.exit(exitCode)
}

child.on('error', (error) => finish(127, { stderr: `${stderr}\n${error.message}` }))
child.on('close', (code, signal) => {
  if (timedOut) finish(124)
  else if (code !== null) finish(code)
  else finish(1, { stderr: `${stderr}\nsignal ${signal}` })
})
