/**
 * Host-plane plugin: contributes `DSH_ANDROID_*` facts to every shell call and
 * creates the shared layout. It deliberately registers no tools — the tool
 * surface is the MCP server in `cordis.patch.yml`, which also works for
 * presets that do not mount this plugin.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { binPath, resolveRoot, runPaths } from './src/paths.mjs'

export const name = 'dsh-android-toolchain'
export const inject = ['shellEnv']

export function apply(ctx) {
  const root = resolveRoot({})
  // Fast, idempotent: creating directories is cheap, provisioning is not done
  // here (it downloads hundreds of megabytes and belongs to --auto/explicit).
  for (const dir of [root, join(root, 'bin'), runPaths(root).runDir, runPaths(root).queue]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {}
  }

  try {
    ctx.shellEnv.register({
      name: 'android-toolchain',
      variables: {
        DSH_ANDROID_ROOT: { description: 'Shared Android/JVM toolchain root (JDK, Gradle, launchers).' },
        DSH_ANDROID_BROKER: { description: 'Launcher of the single-slot build broker used by the android MCP server.' },
      },
      resolve: () => ({
        DSH_ANDROID_ROOT: root,
        DSH_ANDROID_BROKER: binPath(root, 'android-broker'),
      }),
    })
  } catch (error) {
    ctx.logger?.warn?.(`[android-toolchain] shell-env facts not registered: ${error?.message ?? error}`)
  }
}
