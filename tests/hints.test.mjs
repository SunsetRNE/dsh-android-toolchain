import assert from 'node:assert/strict'
import test from 'node:test'
import { explainFailure, failureHints } from '../src/hints.mjs'

const ids = (text) => explainFailure(text).map((item) => item.id)

test('a successful build produces no hints, including the bionic aapt2 warning', () => {
  const noisySuccess = [
    'BUILD SUCCESSFUL in 39s',
    'AAPT2 bin Daemon #0: Unexpected error output: WARNING: linker: /system/bin/linker64: unused DT entry',
  ].join('\n')
  assert.deepEqual(explainFailure(noisySuccess), [])
  assert.deepEqual(explainFailure(''), [])
})

test('common failures map to actionable hints', () => {
  assert.deepEqual(ids('* What went wrong:\nSDK location not found. Define a valid SDK location.'), ['sdk-missing'])
  assert.deepEqual(ids('AAPT2 aapt2-8.7.3 Exec format error'), ['aapt2-wrong-arch'])
  assert.deepEqual(ids('java.lang.OutOfMemoryError: Java heap space'), ['out-of-memory'])
  assert.deepEqual(ids("Could not resolve all files for configuration ':app:debugRuntimeClasspath'"), ['dependency-unresolved'])
  assert.deepEqual(
    ids('uses-sdk:minSdkVersion 24 cannot be smaller than version 26 declared in library [:lib]'),
    ['minsdk-conflict'],
  )
  assert.deepEqual(ids('Duplicate class kotlin.collections.jdk8 found in modules'), ['duplicate-class'])
  assert.deepEqual(ids('Minimum supported Gradle version is 8.9. Current version is 8.7'), ['gradle-too-old'])
  assert.deepEqual(ids('Keystore was tampered with, or password was incorrect'), ['signing-credentials'])
  assert.deepEqual(ids('Failure [INSTALL_FAILED_OLDER_SDK: Requires newer sdk version]'), ['device-sdk-too-old'])
  assert.deepEqual(ids('INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match'), ['install-signature-mismatch'])
  assert.deepEqual(ids('write failed: ENOSPC'), ['disk-full'])
})

test('hints are capped and deduplicated', () => {
  const many = [
    'SDK location not found.',
    'AAPT2 aapt2-8.7.3 Exec format error',
    'OutOfMemoryError: Java heap space',
    'Could not resolve all files',
    'Duplicate class x',
  ].join('\n')
  const hints = explainFailure(many)
  assert.equal(hints.length, 3)
  assert.equal(new Set(hints.map((item) => item.id)).size, 3)
  assert.equal(failureHints(many).length, 3)
})
