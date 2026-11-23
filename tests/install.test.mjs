import assert from 'node:assert/strict'
import test from 'node:test'
import { bridgePort, bridgeUrl, parseHeaders } from '../src/bridge.mjs'
import { classifyInstallResult } from '../src/install.mjs'

test('installer/notification results are requests, not successes', () => {
  const installer = classifyInstallResult('OK: installer')
  assert.equal(installer.requested, true)
  assert.equal(installer.mode, 'installer')
  assert.equal(installer.installed, false)
  assert.match(installer.note, /confirm it there/)

  const notification = classifyInstallResult('OK: notification')
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
