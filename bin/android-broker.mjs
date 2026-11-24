#!/usr/bin/env node
/**
 * MCP stdio broker. One server for the whole Host (the MCP manager mounts a
 * single instance per enabled entry), but every build still goes through the
 * file lock, so the CLI, subagents and a second broker instance cannot overlap.
 *
 * stdout is the JSON-RPC channel: never print anything else here.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serveStdio } from '../src/mcp.mjs'
import { binPath, resolveRoot } from '../src/paths.mjs'
import { buildEnv, withAapt2Override } from '../src/env.mjs'
import { runInSlot } from '../src/slot.mjs'
import { doctor } from '../src/doctor.mjs'
import { describeAllRoots, describeRoot } from '../src/inspect.mjs'
import { registryPath, resolveRootRef } from '../src/roots.mjs'
import { summarize } from '../src/junit.mjs'
import { failureHints } from '../src/hints.mjs'
import { signApk } from '../src/signing.mjs'
import { installApk } from '../src/install.mjs'
import { loadManifest } from '../src/manifest.mjs'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const root = resolveRoot({ create: true })
const manifest = loadManifest()
const PROVISIONER = fileURLToPath(new URL('./android-provision.mjs', import.meta.url))

const tail = (text, limit = 8000) => (text.length > limit ? `…(truncated)\n${text.slice(-limit)}` : text)
const json = (value) => JSON.stringify(value, null, 2)

const env = () => buildEnv(root)

const tools = [
  {
    name: 'android_status',
    description: 'Show the shared toolchain root, installed components, and the single build slot (holder + waiters). Cheap: call it before and after a build. Pass all:true to summarize every registered root, or root to inspect one.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Summarize every root in the registry (each has its own slot and limits).' },
        root: { type: 'string', description: 'Registered label or absolute path; default: the primary root.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      try {
        if (args?.all) return { text: json(describeAllRoots(root, { recent: 5, manifest })) }
        const target = resolveRootRef(args?.root, { primary: root })
        return { text: json({ ...describeRoot(target, { manifest }), registry: registryPath(root) }) }
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
    },
  },
  {
    name: 'android_doctor',
    description: 'Diagnose the shared area: real ELF architecture of java/gradle, versions, disk and memory headroom, provisioning warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Also run `gradle --version` (slow).' },
        cache: { type: 'boolean', description: 'Measure cache sizes and write the report; slow on large caches (minutes). Default: reuse the last report.' },
        root: { type: 'string', description: 'Registered label or absolute path; default: the primary root.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      try {
        const target = resolveRootRef(args?.root, { primary: root })
        return { text: json(doctor({ root: target, full: Boolean(args?.full), cache: Boolean(args?.cache), manifest })) }
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
    },
  },
  {
    name: 'android_provision',
    description: 'Install or repair the shared toolchain from toolchain.manifest.json. Idempotent, sha256-pinned, serialized through the build slot.',
    inputSchema: {
      type: 'object',
      properties: {
        components: { type: 'array', items: { type: 'string' }, description: 'Component names from the manifest; default: every enabled component.' },
        dryRun: { type: 'boolean' },
        allowUnpinned: { type: 'boolean', description: 'Allow archives without a pinned sha256 (not recommended).' },
        root: { type: 'string', description: 'Target root: registered label or absolute path. Provisioning runs in that root\'s slot.' },
        reuseFrom: { type: 'string', description: 'Copy matching archives from this root (label or path) instead of downloading them again.' },
        register: { type: 'boolean', description: 'Add the target root to the registry so it can be referenced by label.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      let target
      try {
        target = resolveRootRef(args?.root, { primary: root })
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
      const extra = []
      if (target !== root) extra.push('--root', target)
      if (args?.reuseFrom) {
        try {
          extra.push('--reuse-from', resolveRootRef(args.reuseFrom, { primary: root }))
        } catch (error) {
          return { isError: true, text: error?.message ?? String(error) }
        }
      }
      if (args?.register) extra.push('--register')
      for (const component of args?.components ?? []) extra.push('--component', component)
      if (args?.dryRun) extra.push('--dry-run')
      if (args?.allowUnpinned) extra.push('--allow-unpinned')
      const result = await runInSlot({
        root: target,
        cmd: process.execPath,
        args: [PROVISIONER, ...extra],
        owner: `provision:${process.pid}`,
        env: env(),
      })
      return {
        text: json({ exitCode: result.exitCode, busy: Boolean(result.busy), reason: result.reason, output: tail(result.stdout), errors: tail(result.stderr) }),
        isError: !result.ok,
      }
    },
  },
  {
    name: 'android_build',
    description: 'Run one Gradle task through the single build slot (nice 19, pinned CPUs, wall-clock timeout, queue cap). Returns exit code plus the tail of the output.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Gradle task, e.g. `assembleDebug` or `test`. Default: build.' },
        tasks: { type: 'array', items: { type: 'string' }, description: 'Several tasks in one invocation.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra Gradle arguments, e.g. `--offline`.' },
        cwd: { type: 'string', description: 'Project directory containing the Gradle wrapper; defaults to the broker cwd.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock cap; defaults to 1200000.' },
        owner: { type: 'string', description: 'Label recorded in the slot holder, e.g. the issue or session name.' },
        root: { type: 'string', description: 'Registered label or absolute path; default: the primary root. Roots build in parallel.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      let target
      try {
        target = resolveRootRef(args?.root, { primary: root })
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
      const gradle = binPath(target, 'gradle')
      if (!existsSync(gradle)) {
        return { isError: true, text: `gradle is not provisioned under ${target}. Run android_provision first.` }
      }
      const tasks = args?.tasks?.length ? args.tasks : [args?.task ?? 'build']
      const extra = [...(args?.args ?? [])]
      const result = await runInSlot({
        root: target,
        cmd: gradle,
        args: withAapt2Override(target, [...tasks, ...extra]),
        cwd: args?.cwd ?? process.cwd(),
        env: buildEnv(target),
        owner: args?.owner ?? `build:${process.pid}`,
        timeoutMs: args?.timeoutMs,
      })
      const hints = result.ok ? [] : failureHints(`${result.stdout}\n${result.stderr}`)
      return {
        isError: !result.ok,
        text: json({
          buildId: result.id,
          exitCode: result.exitCode,
          busy: Boolean(result.busy),
          timedOut: Boolean(result.timedOut),
          reason: result.reason,
          waitedMs: result.waitedMs,
          durationMs: result.durationMs,
          ...(hints.length ? { hints } : {}),
          output: tail(result.stdout),
          errors: tail(result.stderr),
        }),
      }
    },
  },
  {
    name: 'android_test',
    description: 'Run Gradle tests through the single slot and summarize the JUnit XML (tests, failures, errors, skipped, failing cases). Returns exit code, buildId and the output tail.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'string' }, description: 'Gradle test tasks; default: test.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra Gradle arguments, e.g. --tests or -Pfoo=bar.' },
        cwd: { type: 'string', description: 'Project directory; defaults to the broker cwd.' },
        timeoutMs: { type: 'integer' },
        owner: { type: 'string' },
        root: { type: 'string', description: 'Registered label or absolute path; default: the primary root.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      let target
      try {
        target = resolveRootRef(args?.root, { primary: root })
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
      const gradle = binPath(target, 'gradle')
      if (!existsSync(gradle)) {
        return { isError: true, text: `gradle is not provisioned under ${target}. Run android_provision first.` }
      }
      const projectDir = args?.cwd ?? process.cwd()
      const tasks = args?.tasks?.length ? args.tasks : ['test']
      const result = await runInSlot({
        root: target,
        cmd: gradle,
        args: withAapt2Override(target, [...tasks, ...(args?.args ?? [])]),
        cwd: projectDir,
        env: buildEnv(target),
        owner: args?.owner ?? `test:${process.pid}`,
        timeoutMs: args?.timeoutMs,
      })
      const summary = result.busy ? null : summarize(projectDir)
      const hints = result.ok ? [] : failureHints(`${result.stdout}\n${result.stderr}`)
      return {
        isError: !result.ok,
        text: json({
          buildId: result.id,
          exitCode: result.exitCode,
          busy: Boolean(result.busy),
          timedOut: Boolean(result.timedOut),
          reason: result.reason,
          waitedMs: result.waitedMs,
          durationMs: result.durationMs,
          ...(hints.length ? { hints } : {}),
          summary,
          output: tail(result.stdout),
          errors: tail(result.stderr),
        }),
      }
    },
  },
  {
    name: 'android_sign',
    description: 'Sign an APK with the configured release keystore through apksigner.jar and verify the signature. Passwords come from <root>/signing.json or ANDROID_* environment variables and are never accepted as arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        apk: { type: 'string', description: 'APK to sign (never modified in place).' },
        out: { type: 'string', description: 'Output path; defaults to <name>-signed.apk next to the input.' },
        keystore: { type: 'string', description: 'Override the keystore path from the signing config.' },
        alias: { type: 'string', description: 'Override the key alias from the signing config.' },
        timeoutMs: { type: 'integer' },
        waitMs: { type: 'integer', description: 'How long to wait for the build slot; default 120000.' },
        owner: { type: 'string' },
        root: { type: 'string', description: 'Registered label or absolute path; default: the primary root.' },
      },
      required: ['apk'],
      additionalProperties: false,
    },
    handler: async (args) => {
      let target
      try {
        target = resolveRootRef(args?.root, { primary: root })
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
      try {
        const result = await signApk({
          root: target,
          apk: args?.apk,
          out: args?.out,
          keystore: args?.keystore,
          alias: args?.alias,
          timeoutMs: args?.timeoutMs,
          waitMs: args?.waitMs,
          owner: args?.owner ?? `sign:${process.pid}`,
        })
        return { text: json(result), isError: !result.ok }
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
    },
  },
  {
    name: 'android_install',
    description: 'Hand an APK to the Android system installer through the DSHA app bridge. The user confirms on the device: OK means the request was made, not that the package is installed. Optionally reports the currently installed version of the package.',
    inputSchema: {
      type: 'object',
      properties: {
        apk: { type: 'string', description: 'APK path visible inside the container (or /sdcard).' },
        packageName: { type: 'string', description: 'Package id to report after requesting (e.g. com.example.hello).' },
        root: { type: 'string', description: 'Root whose history records the request; default: the primary root.' },
      },
      required: ['apk'],
      additionalProperties: false,
    },
    handler: async (args) => {
      let target
      try {
        target = resolveRootRef(args?.root, { primary: root })
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
      try {
        const result = await installApk({ apk: args?.apk, packageName: args?.packageName, root: target })
        return { text: json(result), isError: !result.requested }
      } catch (error) {
        return { isError: true, text: error?.message ?? String(error) }
      }
    },
  },
]

serveStdio({
  name: 'android-toolchain',
  version: PKG.version,
  instructions:
    'Shared Android/JVM toolchain on this device. Call android_status first; builds go through android_build so they queue on one slot per root (pass root for a second toolchain, all on android_status to list them). Never run gradle directly in bash: that bypasses the slot and can OOM the device.',
  tools,
})
