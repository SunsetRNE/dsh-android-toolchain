import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const BROKER = fileURLToPath(new URL('../bin/android-broker.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'android-mcp-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

/** Minimal stdio MCP client: writes newline-delimited JSON-RPC, reads replies. */
function startBroker() {
  const child = spawn(process.execPath, [BROKER], {
    env: { ...process.env, DSH_ANDROID_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const pending = new Map()
  const notifications = []
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.id === undefined) notifications.push(message)
      else {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    }
  })
  let nextId = 1
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return { child, request, notify, notifications }
}

test('broker speaks MCP: initialize, tools/list, tools/call', async () => {
  const { child, request } = startBroker()
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(initialized.result.protocolVersion, '2025-06-18')
    assert.deepEqual(initialized.result.capabilities.tools, { listChanged: true })

    const listed = await request('tools/list', {})
    const names = listed.result.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['android_build', 'android_doctor', 'android_install', 'android_provision', 'android_sign', 'android_status', 'android_test'])
    for (const tool of listed.result.tools) assert.equal(tool.inputSchema.type, 'object')

    const status = await request('tools/call', { name: 'android_status', arguments: {} })
    assert.equal(status.result.isError, undefined)
    const payload = JSON.parse(status.result.content[0].text)
    assert.equal(payload.root, root)
    assert.equal(payload.slot.limits.maxQueue, 3)
  } finally {
    child.kill('SIGKILL')
  }
})

test('initialized triggers one tools/list_changed notification', async () => {
  const { child, request, notify, notifications } = startBroker()
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    notify('notifications/initialized')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(notifications.map((entry) => entry.method), ['notifications/tools/list_changed'])
  } finally {
    child.kill('SIGKILL')
  }
})

test('an unknown tool is a protocol error, not a crash', async () => {
  const { child, request } = startBroker()
  try {
    const reply = await request('tools/call', { name: 'nope', arguments: {} })
    assert.equal(reply.error.code, -32602)
    const again = await request('tools/list', {})
    assert.ok(again.result.tools.length > 0)
  } finally {
    child.kill('SIGKILL')
  }
})

test('build without a provisioned gradle returns a hint, not an exception', async () => {
  const { child, request } = startBroker()
  try {
    const reply = await request('tools/call', { name: 'android_build', arguments: { task: 'assembleDebug' } })
    assert.equal(reply.result.isError, true)
    assert.match(reply.result.content[0].text, /not provisioned/)
  } finally {
    child.kill('SIGKILL')
  }
})
