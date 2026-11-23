/**
 * The environment every build-ish child gets. One implementation so the broker,
 * the CLI and `android-test` cannot drift on JAVA_HOME / SDK path / aapt2.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { aapt2Override, binPath, currentPath, sdkRoot } from './paths.mjs'

/** Environment for a Gradle child process. */
export function buildEnv(root, base = process.env) {
  const env = {
    ...base,
    PATH: [join(root, 'bin'), base.PATH ?? ''].filter(Boolean).join(':'),
    JAVA_HOME: join(root, 'jdk', 'current'),
    GRADLE_USER_HOME: join(root, 'gradle-home'),
  }
  const sdk = sdkRoot(root)
  if (sdk) {
    env.ANDROID_HOME = sdk
    env.ANDROID_SDK_ROOT = sdk
  }
  const ndk = currentPath(root, 'ndk')
  if (existsSync(ndk)) env.ANDROID_NDK_HOME = ndk
  return env
}

/**
 * Append the arm64 aapt2 override unless the caller already set one.
 * AGP otherwise downloads the x86_64 aapt2 from Google Maven.
 */
export function withAapt2Override(root, args) {
  const override = aapt2Override(root)
  if (!override) return args
  if (args.some((item) => item.startsWith('-Pandroid.aapt2FromMavenOverride='))) return args
  return [...args, `-Pandroid.aapt2FromMavenOverride=${override}`]
}

/** Launcher path for a tool in the shared bin directory. */
export function toolPath(root, tool) {
  return binPath(root, tool)
}
