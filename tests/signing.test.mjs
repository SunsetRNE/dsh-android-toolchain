import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadSigningConfig, parseCertDigest, resolveOutput, signingHint } from '../src/signing.mjs'

const root = mkdtempSync(join(tmpdir(), 'android-signing-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

const env = {}

test('a missing config reports exactly what is missing, without secrets', () => {
  const config = loadSigningConfig(root, env)
  assert.deepEqual(config.missing, ['keystore', 'alias', 'storePassword'])
  assert.equal(config.configFile, null)
  assert.doesNotMatch(signingHint(root), /password\s*[:=]\s*\S+/i)
})

test('signing.json supplies keystore, alias and a password file', () => {
  const passwordFile = join(root, 'store.pass')
  writeFileSync(passwordFile, 'correct horse\n')
  writeFileSync(
    join(root, 'signing.json'),
    JSON.stringify({ keystore: '/tmp/release.jks', alias: 'release', storePasswordFile: passwordFile }),
  )
  const config = loadSigningConfig(root, env)
  assert.equal(config.configFile, join(root, 'signing.json'))
  assert.equal(config.keystore, '/tmp/release.jks')
  assert.equal(config.alias, 'release')
  assert.equal(config.storePassword, 'correct horse')
  assert.equal(config.keyPassword, config.storePassword, 'key password defaults to the store password')
})

test('environment variables win over signing.json', () => {
  const config = loadSigningConfig(root, {
    ANDROID_KEYSTORE: '/tmp/from-env.jks',
    ANDROID_KEY_ALIAS: 'env',
    ANDROID_KEYSTORE_PASSWORD: 'envpass',
    ANDROID_KEY_PASSWORD: 'envkey',
  })
  assert.equal(config.keystore, '/tmp/from-env.jks')
  assert.equal(config.alias, 'env')
  assert.equal(config.keyPassword, 'envkey')
})

test('a non-existent keystore file is reported', () => {
  writeFileSync(join(root, 'signing.json'), JSON.stringify({ keystore: '/tmp/does-not-exist.jks', alias: 'a', storePassword: 'x' }))
  const config = loadSigningConfig(root, env)
  assert.deepEqual(config.missing, ['keystore-file'])
})

test('output path defaults next to the input and never in place', () => {
  assert.equal(resolveOutput('/tmp/app-debug.apk'), '/tmp/app-debug-signed.apk')
  assert.equal(resolveOutput('/tmp/app-debug.apk', '/tmp/out.apk'), '/tmp/out.apk')
  assert.throws(() => resolveOutput('/tmp/app-debug.apk', '/tmp/app-debug.apk'), /in place/)
  assert.throws(() => resolveOutput('/tmp/app-debug.apk', '/tmp/out.zip'), /must end with \.apk/)
})

test('cert digest is parsed from apksigner output', () => {
  const output = 'Signer #1 certificate SHA-256 digest: 5f1c0e9a3b2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcd\n'
  assert.equal(parseCertDigest(output), '5f1c0e9a3b2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcd')
  assert.equal(parseCertDigest('nothing here'), null)
})
