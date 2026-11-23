/**
 * Read-only inspection of the shared area: what is installed, which architecture
 * the binaries really are, how much room is left, who holds the build slot.
 * The provisioner and the broker both use it, so `android-doctor` and the
 * `android_doctor` MCP tool can never disagree.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { aapt2Override, currentPath, resolveRoot, sdkRoot } from './paths.mjs'
import { readSlotState } from './slot.mjs'
import { components, enabledComponents, loadManifest } from './manifest.mjs'
import { readHistory } from './history.mjs'
import { findApksigner, loadSigningConfig } from './signing.mjs'

/** ELF machine ids we care about. */
const ELF_MACHINE = { 0xb7: 'aarch64', 0x3e: 'x86_64', 0x28: 'arm', 0x03: 'i386' }

/** `file`-style architecture probe without depending on `file`. */
export function elfMachine(file) {
  try {
    const target = realpathSync(file)
    const buffer = readFileSync(target).subarray(0, 20)
    if (buffer[0] !== 0x7f || buffer[1] !== 0x45) return 'script' // #!E
    const little = buffer[5] === 1
    const value = little ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18)
    return ELF_MACHINE[value] ?? `elf:0x${value.toString(16)}`
  } catch {
    return 'missing'
  }
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0]?.slice(0, 200) ?? ''
}

function runVersion(cmd, args, prefer) {
  // `java -version` prints on stderr, `gradle --version` on stdout, and aapt2
  // prints its version plus a linker warning on stderr, so pick deliberately.
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 })
  if (result.error) return `error: ${result.error.message}`
  const lines = `${result.stderr ?? ''}${result.stdout ?? ''}`.split('\n').map((line) => line.trim()).filter(Boolean)
  const match = prefer ? lines.find((line) => prefer.test(line)) : undefined
  const fallback = lines.find((line) => /(Gradle|aapt|openjdk|version)\s+[^\s]*\d/i.test(line))
  return (match ?? fallback ?? lines[0] ?? `exit ${result.status}`).slice(0, 200)
}

function memory() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8')
    const read = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(info)?.[1] ?? 0) * 1024
    return { availableBytes: read('MemAvailable'), swapFreeBytes: read('SwapFree') }
  } catch {
    return {}
  }
}

export function doctor({ root: rootOption, manifest = loadManifest(), full = false } = {}) {
  const root = rootOption ?? resolveRoot({})
  const state = readSlotState(root)
  const installed = {}
  for (const component of components(manifest)) {
    const current = currentPath(root, component.name)
    let versions = []
    try {
      versions = readdirSync(join(root, component.name)).filter((name) => name !== 'current')
    } catch {}
    installed[component.name] = {
      enabled: Boolean(component.enabled),
      pinned: Boolean(component.sha256),
      current: elfTarget(current) ? realpathSync(current) : null,
      versions,
    }
  }

  const javaHome = join(root, 'jdk', 'current')
  const checks = {
    java: { path: join(javaHome, 'bin', 'java'), arch: elfMachine(join(javaHome, 'bin', 'java')), version: runVersion(join(javaHome, 'bin', 'java'), ['-version'], /version/i) },
    gradle: { path: join(root, 'bin', 'gradle'), arch: elfMachine(join(root, 'bin', 'gradle')), version: full ? runVersion(join(root, 'bin', 'gradle'), ['--version'], /Gradle \d/) : undefined },
    broker: { path: join(root, 'bin', 'android-broker'), arch: elfMachine(join(root, 'bin', 'android-broker')) },
  }
  const aapt2 = aapt2Override(root)
  checks.aapt2 = aapt2
    ? { path: aapt2, version: runVersion(aapt2, ['version'], /aapt/i) }
    : { path: null, installed: false }
  const apksigner = findApksigner(root)
  checks.apksigner = { path: apksigner }
  try {
    const signing = loadSigningConfig(root)
    checks.signing = {
      configured: signing.missing.length === 0,
      configFile: signing.configFile,
      keystore: signing.keystore ?? null,
      alias: signing.alias ?? null,
      missing: signing.missing,
    }
  } catch (error) {
    checks.signing = { configured: false, error: error.message }
  }
  const sdk = sdkRoot(root)
  checks.sdk = sdk ? { path: sdk, platforms: listDirs(join(sdk, 'platforms')), buildTools: listDirs(join(sdk, 'build-tools')) } : { path: null, installed: false }

  let disk = {}
  try {
    const stats = statfsSync(root)
    disk = { availableBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
  } catch {}

  const warnings = []
  for (const component of enabledComponents(manifest)) {
    if (!installed[component.name]?.current) warnings.push(`${component.name} is enabled but not installed; run android-provision`)
  }
  if (checks.java.arch !== 'missing' && checks.java.arch !== 'script' && checks.java.arch !== 'aarch64') {
    warnings.push(`java is ${checks.java.arch}, not aarch64: it cannot run on this device`)
  }
  if (!state.holder && state.queue.length > 0) warnings.push('waiters are queued without a holder; check android_status')

  let gradleDaemons = null
  try {
    const pgrep = spawnSync('pgrep', ['-fc', 'GradleDaemon'], { encoding: 'utf8' })
    gradleDaemons = Number((pgrep.stdout ?? '').trim() || '0')
  } catch {}

  return {
    root,
    limits: state.limits,
    limitWarnings: state.limitWarnings,
    gradleDaemons,
    recentBuilds: readHistory(root, 3),
    slot: state,
    components: installed,
    checks,
    disk,
    memory: memory(),
    warnings,
  }
}

function listDirs(path) {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

function elfTarget(path) {
  try {
    realpathSync(path)
    return true
  } catch {
    return false
  }
}
