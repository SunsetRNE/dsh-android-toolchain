import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isInstalledCopy } from '../src/paths.mjs'

const work = mkdtempSync(join(tmpdir(), 'android-copies-'))
test.after(() => rmSync(work, { recursive: true, force: true }))

test('without DSH_HOME every copy may link globally (CI, plain containers)', () => {
  assert.equal(isInstalledCopy(join(work, 'checkout'), 'dsh-android-toolchain', {}), true)
})

test('only the profile copy writes the machine-wide launchers', () => {
  const home = join(work, 'home')
  const installed = join(home, 'plugin-src', 'dsh-android-toolchain')
  const checkout = join(work, 'checkout')
  mkdirSync(installed, { recursive: true })
  mkdirSync(checkout, { recursive: true })

  assert.equal(isInstalledCopy(installed, 'dsh-android-toolchain', { DSH_HOME: home }), true)
  assert.equal(isInstalledCopy(checkout, 'dsh-android-toolchain', { DSH_HOME: home }), false)
  assert.equal(isInstalledCopy(join(home, 'missing'), 'dsh-android-toolchain', { DSH_HOME: home }), false)
})

test('a profile copy linked to a checkout still counts (realpath)', () => {
  const home = join(work, 'linked-home')
  const checkout = join(work, 'linked-checkout')
  mkdirSync(join(home, 'plugin-src'), { recursive: true })
  mkdirSync(checkout, { recursive: true })
  symlinkSync(checkout, join(home, 'plugin-src', 'dsh-android-toolchain'))
  assert.equal(isInstalledCopy(checkout, 'dsh-android-toolchain', { DSH_HOME: home }), true)
})
