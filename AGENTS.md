# AGENTS.md — dsh-android-toolchain

本文件面向在这个仓库里工作的 agent 和维护者。目标不是“能编译”，而是**任何 DSH 会话都能用、并发时不互相踩、升级不丢工具链**。

## 布局与不变量

| 路径 | 角色 | 不变量 |
|---|---|---|
| `bin/*.mjs` | 可执行入口（MCP broker、CLI） | 只做参数解析与编排；**stdout 是 MCP JSON-RPC 通道，任何 `console.log` 都会毁掉会话** |
| `src/*.mjs` | 纯模块，可被测试直接 import | 不读 `process.argv`，不在 import 时写盘 |
| `src/slot.mjs` | 单槽实现 | 必须走 `flock` 文件锁；不得改回进程内信号量（MCP 探测进程、服务进程、CLI、子代理是不同进程） |
| `toolchain.manifest.json` | 唯一供应链 | 组件版本/来源/sha256/Gradle 参数只在这里改；**发布前每个 enabled 组件都必须 pin** |
| `cordis.patch.yml` | Host 平面接线 | 只插入 `android-toolchain`（shell-env facts）和 `android-toolchain-mcp`（stdio MCP）两行 |
| `index.js` | Host 插件 | 只做轻量建目录 + `DSH_ANDROID_*` facts；**不要在这里下载工具链**（阻塞 Host 启动） |
| `tests/` | 行为契约 | 必须能在没有网络、没有 `/opt` 写权限的 CI 里跑；测试用临时根，不许碰真实共享区 |

工具链安装在 `<root>`（默认 `/opt/android-toolchain`），**永远不要**放进 `node_modules`、profile 或 workspace。

## 常用命令

```sh
node --test tests/*.test.mjs                 # 全部测试（约 9s）
node bin/android-provision.mjs --dry-run     # 供应计划，不写盘
node bin/android-provision.mjs --pin --write # 回填 sha256（发布前必须）
node bin/android-provision.mjs --verify-manifest --strict   # 发布门禁
node bin/android-status.mjs                  # 槽位/已装组件
node bin/android-doctor.mjs [--full]         # 架构/版本/余量诊断
```

本机验证 MCP 接线（不装插件也能测）：

```sh
DSH_ANDROID_ROOT=/tmp/toolchain node bin/android-broker.mjs   # 然后按 JSON-RPC 写 stdin
```

## 修改协议

1. **改上限**（槽位/排队/超时/nice/CPU）：改 `src/slot.mjs` 的 `LIMITS`，同步 README 的上限表，并更新 `tests/slot.test.mjs`。
2. **加/升组件**：改 `toolchain.manifest.json` → `--pin --write` → 跑 `--verify-manifest --strict` → README 的 aarch64 边界表如涉及能力变化要一起改。
3. **加 MCP 工具**：在 `bin/android-broker.mjs` 的 `tools` 里加 schema + handler，补 `tests/mcp.test.mjs` 的 `tools/list` 断言，更新 README 工具表。
4. **改 `cordis.patch.yml`**：确认 `toolCallTimeoutMs`（构建可能 20 分钟）、`failOnStartupError: false`（broker 缺失时不要拖垮启动）仍成立。

## APK 路径（arm64）

- `scripts/setup-apk.sh` 是唯一入口：cmdline-tools（Java）→ platform/build-tools → Termux arm64 aapt2 包装器。
- **不要**把 build-tools 的原生 x86_64 工具当可用；只有 aapt2 被替换，其余 Java 工具（d8/R8/apksigner.jar）才可用。
- aapt2 的 `.deb` 必须按 sha256 校验：升级时同步改脚本里的 `AAPT2_VERSION` 与 `AAPT2_SHA256`，并跑一次真实 `assembleDebug`。
- `android-build`/broker 在检测到 `<root>/aapt2/current/bin/aapt2` 时自动加 `-Pandroid.aapt2FromMavenOverride=`；调用方显式传了就不要覆盖。
- SDK 布局在 `<root>/sdk`（sdkmanager 原生布局，无 `current` 软链），`sdkRoot()` 同时兼容 `<root>/sdk/current`。

## 发布清单

- [ ] `node --test tests/*.test.mjs` 全绿
- [ ] `--verify-manifest --strict` 通过（每个 enabled 组件 pinned 且来源可达）
- [ ] APK 脚本仍可跑：`sh scripts/setup-apk.sh` && 真实 `assembleDebug` 通过
- [ ] `package.json` 版本号 + `CHANGELOG`（若启用）已更新
- [ ] 打 `vX.Y.Z` tag；release 工作流只出 tarball + `SHA256SUMS`（**不要加 npm publish**：维护者无法注册 npm）
- [ ] 发布后在一台设备上 `dsha-plugin import <tarball>` 并重启 Web，新会话里 `mcp__android__android_doctor` 架构为 `aarch64`

## 设备侧部署约定（维护者本机）

共享区是**一台设备一份**，不要每个 workspace 各装一套：

```sh
# 一次性
android-provision                 # 装 jdk + gradle 到 /opt/android-toolchain
android-doctor                    # 确认 java 是 aarch64
```

然后在 `~/.dsh/AGENTS.md`（用户级，所有会话首请求加载）留索引，而不是在项目里重复说明：

```md
## 编译工具链
- 共享区：/opt/android-toolchain（JDK/Gradle 已装好，launcher 在 /usr/local/bin 与 <root>/bin）
- 构建：优先 `mcp__android__android_build`；命令行用 `android-build <task>`；
  环境变量需要时 `source /opt/android-toolchain/bin/env.sh`
- 禁止：在 workspace 里再装 SDK/JDK；直接 `bash gradle` 绕过单槽
- 设备是 aarch64 proot：官方 build-tools/NDK 的 x86_64 二进制不可运行
```

## 禁止事项

- 不要提交任何二进制/工具链/`*.tgz`；仓库只放供应逻辑与 manifest。
- 不要在 `enabled: true` 时留空 sha256 发布。
- 不要把 broker 的日志写到 stdout；调试用 stderr 或 `android-status`。
- 不要用 `prlimit --as` 限制构建进程（JVM 会起不来）；内存上限靠 `-Xmx` + 单槽。
- 不要把工具链装进 profile 的 `node_modules`：插件升级会把它删掉。
