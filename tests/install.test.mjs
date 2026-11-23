import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readHistory } from '../src/history.mjs'
import { installApk } from '../src/install.mjs'
import { bridgePort, bridgeUrl, parseHeaders } from '../src/bridge.mjs'
import { classifyInstallResult } from '../src/install.mjs'

test('installer/notification results are requests, not successes', () => {
  const installer = classifyInstallResult('OK: installer 已请求系统安装器 com.example.hello 1.0 (1)')
  assert.equal(installer.requested, true)
  assert.equal(installer.mode, 'installer')
  assert.match(installer.detail, /com\.example\.hello/)
  assert.equal(installer.installed, false)
  assert.match(installer.note, /confirm it there/)

  const notification = classifyInstallResult('OK: notification 请点通知')
  assert.equal(notification.requested, true)
  assert.match(notification.note, /notification/)
})

test('refusals carry actionable guidance', () => {
  const denied = classifyInstallResult('NO_PERMISSION')
  assert.equal(denied.requested, false)
  assert.equal(denied.code, 'NO_PERMISSION')
  assert.match(denied.note, /unknown apps/i)

  const missing = classifyInstallResult('NOT_FOUND: /tmp/x.apk')
  assert.equal(missing.code, 'NOT_FOUND')
  assert.match(missing.note, /does not exist/)
})

test('bridge URLs encode query values and keep the token out of the URL', () => {
  const url = bridgeUrl('/app/install', { path: '/tmp/a b.apk' }, { env: { DSH_BRIDGE_PORT: '3091' } })
  assert.equal(url.origin, 'http://127.0.0.1:3091')
  assert.equal(url.searchParams.get('path'), '/tmp/a b.apk')
  assert.match(url.toString(), /a(?:%20|\+)b\.apk$/)
  assert.doesNotMatch(url.toString(), /token/i)
})

test('the port comes from the env hook or the port file', () => {
  assert.equal(bridgePort({ env: { DSH_BRIDGE_PORT: '3100' } }), 3100)
  assert.equal(bridgePort({ env: {}, portFile: '/tmp/does-not-exist-port' }), 3091)
})

test('header lines parse into request headers', () => {
  const headers = parseHeaders('X-Token: abc123\n# comment\n\nOther: v\n')
  assert.deepEqual(headers, { 'X-Token': 'abc123', Other: 'v' })
})

test('an install request is audited with its outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'android-install-audit-'))
  const apk = join(root, 'x.apk')
  writeFileSync(apk, 'not really a zip')
  const request = async (path) => ({
    body: { result: path === '/app/install' ? 'OK: installer 已请求 com.example.hello 1.0 (1)' : '[用户应用]\ncom.example.hello' },
  })
  try {
    const result = await installApk({ apk, packageName: 'com.example.hello', root, request })
    assert.equal(result.requested, true)
    assert.equal(result.mode, 'installer')
    const entry = readHistory(root, 1)[0]
    assert.equal(entry.kind, 'install')
    assert.equal(entry.status, 'requested')
    assert.equal(entry.packageName, 'com.example.hello')
    assert.equal(entry.code, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a refused install is audited as blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'android-install-blocked-'))
  const apk = join(root, 'x.apk')
  writeFileSync(apk, 'not really a zip')
  const request = async () => ({ body: { result: 'NO_PERMISSION: 未允许 DSHA 安装未知应用' } })
  try {
    const result = await installApk({ apk, packageName: null, root, request })
    assert.equal(result.requested, false)
    assert.equal(result.code, 'NO_PERMISSION')
    const entry = readHistory(root, 1)[0]
    assert.equal(entry.kind, 'install')
    assert.equal(entry.status, 'blocked')
    assert.equal(entry.code, 'NO_PERMISSION')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
