/**
 * Turn a failed build/sign output into the next action, not a wall of Gradle
 * noise. Rules are deliberately conservative: a pattern that also appears in a
 * successful build (the bionic aapt2 `ld.config.txt` warning) must never
 * produce a hint, and at most three hints are returned per failure.
 *
 * Pure module: callers pass the combined stdout+stderr they already have.
 */

const RULES = [
  {
    id: 'sdk-missing',
    test: /SDK location not found|sdk\.dir is not set|ANDROID_HOME is not set/i,
    hint: '没有可用的 Android SDK：先跑 `sh scripts/setup-apk.sh`，或在项目里写 local.properties 的 sdk.dir=<root>/sdk。',
  },
  {
    id: 'aapt2-wrong-arch',
    test: /Exec format error.*aapt2|aapt2.*Exec format error/i,
    hint: '用的是 x86_64 的 aapt2：必须通过 `android-build`/MCP 构建（会注入 arm64 override），不要直接跑 gradlew。',
  },
  {
    id: 'out-of-memory',
    test: /OutOfMemoryError|Java heap space|GC overhead limit/i,
    hint: 'JVM 内存不足：等构建槽空闲后重试；确有必要再调低 <root>/gradle-home/gradle.properties 的 -Xmx（默认 1536m）。',
  },
  {
    id: 'dependency-unresolved',
    test: /Could not resolve |Could not find [^\s]+\.(aar|jar)|Could not GET '/i,
    hint: '依赖没能解析：网络或仓库地址问题；重试一次，仍失败就检查仓库可达性与镜像配置。',
  },
  {
    id: 'minsdk-conflict',
    test: /uses-sdk:minSdkVersion|minSdkVersion \d+ cannot be smaller|Manifest merger failed.*minSdk/i,
    hint: 'minSdk 冲突：某个依赖要求更高的 minSdk；提高 app 的 minSdk，或用 resolutionStrategy 固定依赖版本。',
  },
  {
    id: 'duplicate-class',
    test: /Duplicate class |Duplicate resources |Program type already present/i,
    hint: '依赖里出现重复类/资源：检查是否有两个版本的同一个库，统一版本或加 exclude。',
  },
  {
    id: 'gradle-too-old',
    test: /Minimum supported Gradle version|Unsupported class file major version/i,
    hint: 'AGP 与 Gradle/JDK 版本不匹配：共享区固定 Gradle 8.10.2 + JDK 21，必要时调整项目的 AGP 版本。',
  },
  {
    id: 'signing-credentials',
    test: /Keystore was tampered|password was incorrect|Failed to read key|Given final block not properly padded|keystore password was incorrect/i,
    hint: '签名材料不对：检查 <root>/signing.json（keystore 路径、别名、密码文件）或 ANDROID_* 环境变量，密码不要写进对话。',
  },
  {
    id: 'device-sdk-too-old',
    test: /INSTALL_FAILED_OLDER_SDK/i,
    hint: '设备 Android 版本低于 APK 的 minSdk：换设备或降低 minSdk 后重新打包。',
  },
  {
    id: 'install-signature-mismatch',
    test: /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i,
    hint: '已装应用与这个 APK 签名不一致：先用同一把 keystore 签名，或让用户卸载旧版本后再装。',
  },
  {
    id: 'disk-full',
    test: /No space left on device|ENOSPC/i,
    hint: '磁盘空间不足：`android-doctor` 的 cache 段会给出可回收目录（通常是 <root>/tmp）。',
  },
]

/**
 * @param {string} text combined stdout + stderr
 * @param {{limit?: number}} [options]
 * @returns {Array<{id: string, hint: string}>}
 */
export function explainFailure(text, { limit = 3 } = {}) {
  const haystack = String(text ?? '')
  if (!haystack.trim()) return []
  const found = []
  for (const rule of RULES) {
    if (found.length >= limit) break
    if (rule.test.test(haystack)) found.push({ id: rule.id, hint: rule.hint })
  }
  return found
}

/** Convenience for CLI/MCP payloads: the hint strings only. */
export function failureHints(text, options) {
  return explainFailure(text, options).map((item) => item.hint)
}
