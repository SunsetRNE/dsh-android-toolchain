/**
 * Read-only inspection of the shared area: what is installed, which architecture
 * the binaries really are, how much room is left, who holds the build slot.
 * The provisioner and the broker both use it, so `android-doctor` and the
 * `android_doctor` MCP tool can never disagree.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aapt2Override, currentPath, resolveRoot, runPaths, sdkRoot } from './paths.mjs'
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

function formatBytes(bytes) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GiB`
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MiB`
  return `${Math.round(bytes / 1024)} KiB`
}

/** `du -sk` (fast path, but still a full walk) — null when unavailable. */
function directorySize(path) {
  if (!existsSync(path)) return null
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8', timeout: 120_000 })
  if (result.error || result.status !== 0) return null
  const kb = Number(String(result.stdout ?? '').trim().split(/\s+/)[0])
  return Number.isFinite(kb) ? kb * 1024 : null
}

/**
 * Cache sizes and cleanup suggestions. Slow on a real profile (a 3 GB Gradle
 * cache with tens of thousands of files takes over a minute on a phone), so
 * `doctor` only measures on demand and otherwise reuses the last report.
 */
export function measureCache(root) {
  const entries = []
  const add = (path, kind, safe, note) => {
    const bytes = directorySize(path)
    if (bytes !== null) entries.push({ path, kind, safe, note, bytes })
  }
  add(join(root, 'tmp'), 'downloads', true, '供应的临时归档与解包目录，可安全清理')
  add(join(root, 'gradle-home', 'caches'), 'gradle-caches', false, 'Gradle 依赖/构建缓存；删除后下次构建变慢')
  add(join(root, 'gradle-home', 'wrapper', 'dists'), 'gradle-dist', false, 'Gradle 发行版缓存；删除后会重新下载')
  add(join(root, 'sdk'), 'sdk', false, 'Android SDK；APK 构建必需')
  add(join(root, 'jdk'), 'jdk', false, 'JDK 版本目录')
  add(join(root, 'gradle'), 'gradle', false, 'Gradle 版本目录')
  add(join(root, 'aapt2'), 'aapt2', false, 'arm64 aapt2 与依赖库')

  const staleVersions = []
  for (const component of ['jdk', 'gradle', 'aapt2']) {
    const dir = join(root, component)
    let current = null
    try {
      current = readlinkSync(join(dir, 'current'))
    } catch {}
    let names = []
    try {
      names = readdirSync(dir).filter((name) => name !== 'current')
    } catch {}
    for (const name of names) {
      if (name === current) continue
      const bytes = directorySize(join(dir, name))
      if (bytes === null) continue
      staleVersions.push({ component, version: name, path: join(dir, name), bytes })
    }
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const reclaimableBytes =
    entries.filter((entry) => entry.safe).reduce((sum, entry) => sum + entry.bytes, 0) +
    staleVersions.reduce((sum, entry) => sum + entry.bytes, 0)

  const suggestions = []
  for (const entry of entries.filter((entry) => entry.safe && entry.bytes > 0)) {
    suggestions.push(`rm -rf ${entry.path}   # 可回收 ${formatBytes(entry.bytes)}（${entry.note}）`)
  }
  for (const stale of staleVersions) {
    suggestions.push(`rm -rf ${stale.path}   # ${stale.component} 旧版本，不影响 current（可回收 ${formatBytes(stale.bytes)}）`)
  }
  if (suggestions.length === 0) suggestions.push('没有明显可回收的缓存')

  return { measuredAt: new Date().toISOString(), totalBytes, reclaimableBytes, entries, staleVersions, suggestions }
}

function cacheReportPath(root) {
  return join(runPaths(root).runDir, 'cache-report.json')
}

export function readCacheReport(root) {
  try {
    return JSON.parse(readFileSync(cacheReportPath(root), 'utf8'))
  } catch {
    return null
  }
}

function writeCacheReport(root, report) {
  try {
    mkdirSync(runPaths(root).runDir, { recursive: true })
    writeFileSync(cacheReportPath(root), `${JSON.stringify(report, null, 2)}\n`)
  } catch {}
}

export function doctor({ root: rootOption, manifest = loadManifest(), full = false, cache = false } = {}) {
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

  let cacheReport
  if (cache) {
    const measured = measureCache(root)
    cacheReport = { ...measured, source: 'live' }
    writeCacheReport(root, measured)
  } else {
    const cached = readCacheReport(root)
    cacheReport = cached
      ? { ...cached, source: 'cached' }
      : { source: 'missing', note: 'run `android-doctor --cache` to measure (slow on large caches)' }
  }

  return {
    root,
    limits: state.limits,
    limitWarnings: state.limitWarnings,
    gradleDaemons,
    recentBuilds: readHistory(root, 3),
    slot: state,
    cache: cacheReport,
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
