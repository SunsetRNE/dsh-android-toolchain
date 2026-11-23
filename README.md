# dsh-android-toolchain

把 Android/JVM 工具链装进**共享区**（默认 `/opt/android-toolchain`），并通过一个**单槽构建 broker**（MCP server）暴露给 DeepSeek Harness 的所有会话。安装这个 bundle = 供应工具链；之后任何会话调 `mcp__android__*` 工具即可编译，不再各自下载 JDK/Gradle，也不会因为并发构建把设备打爆。

> English summary: a DSH bundle that provisions an arm64 JVM toolchain into a shared area and exposes one MCP server (`android`) backed by a single-slot `flock` broker, so concurrent agent sessions queue instead of racing for ~1 GB of free RAM.

## 为什么是 MCP + broker，而不是自写 Cordis 工具

| 事实 | 结论 |
|---|---|
| 工具是**预设作用域**：`tool-bash` 之类都挂在 `preset-*` 的 plugins 列表里 | 自写工具要 override 每个预设，且每次升级 `dsh-web-app` 都要重述完整清单 |
| `mcp-manager` 管**全局平面**：一个 `serverName` 条目对 Host 内所有会话可见 | 用 `serverName: android` 的 stdio MCP 条目，一次配置、所有会话可用 |
| bash 工具是全新非登录 `bash -c`，PATH 来自进程环境 | 插件无法给 shell 加 PATH；入口必须是**已经在 PATH 上的可执行文件** |
| MCP client 的 stdio 传输会先起一个**探测进程**再起服务进程；子代理、CLI 也可能各起一个 broker | 互斥不能是进程内信号量，必须是**文件锁**（`flock`），否则探测/服务/CLI 会互相踩 |

所以职责划分是：**MCP 负责“所有会话都看得见入口”，`flock` 负责“大家排一队”**。

## 架构

```text
     会话 A (agent)        会话 B (subagent)       cron / 其它 app
          │                      │                      │
   mcp__android__build     android-build CLI      android-build CLI
          │                      │                      │
          └──────────────┬───────┴──────────────────────┘
                         ▼
             android-broker (MCP stdio, Host 内单实例)
                         │  flock <root>/run/build.lock
             ┌───────────┴────────────┐
             ▼                        ▼
   nice 19 + taskset + timeout    holder.json / queue/*
             │
     <root>/bin/gradle → <root>/gradle/current → JVM(-Xmx1024m)
```

## 安装

> **不走 npm**：本项目只在 GitHub Release 分发 tarball。原因很实际——维护者无法完成 npm 账号注册（人机验证弹窗弹不出来），所以发布链路里没有 `npm publish`。

两种方式等价，都会把包装进 profile，再由包自带的 `cordis.patch.yml` 插入 `android-toolchain` Host 插件和 `android-toolchain-mcp` 客户端条目：

```sh
# 1) 命令行导入 Release 里的 tarball（tar/zip 均可，自动找 dsh.bundle）
gh release download --repo SunsetRNE/dsh-android-toolchain --pattern '*.tgz'
sha256sum -c SHA256SUMS
dsha-plugin import dsh-android-toolchain-<version>.tgz

# 2) 或 Plugins 页 → install_bundle → 选择解压后的目录
```

导入后可 `dsha-plugin list` 确认，然后**重启 DSHA Web**。

**安装即供应**：包的 `postinstall` 跑 `android-provision --auto`，把 `toolchain.manifest.json` 里 `enabled: true` 的组件下载、校验 sha256、解包到共享区，并安装启动器。

- 想只装插件、不下载工具链：`DSH_ANDROID_PROVISION=off`，之后手动 `android-provision`。
- CI 环境自动跳过（`CI=true`）。
- 安装脚本需要批准（`plugin_manager` 的 build script 门禁）；被拒时插件照常加载，工具会提示“未供应”，手动跑一次 `android-provision` 即可。
- 改完配置需要重启 DSHA Web，MCP 条目才会重新挂载。

## 目录布局（共享区）

```text
/opt/android-toolchain/            # DSH_ANDROID_ROOT 可覆盖
  jdk/<version>/  gradle/<version>/   # 内容寻址的版本目录 + current 软链
  bin/            # java gradle android-broker android-provision android-build ... env.sh
  gradle-home/    # GRADLE_USER_HOME：缓存 + gradle.properties（首次生成后不再覆盖）
  run/            # build.lock / holder.json / queue/  ← 单槽状态
```

工具链**不在** profile 里，也**不在**任何 workspace 里：插件升级不删 JDK，workspace 只是代码。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `mcp__android__android_status` | 共享区、已装组件、当前 holder 与排队者、上限 |
| `mcp__android__android_doctor` | java/gradle 的**真实 ELF 架构**、版本、磁盘/内存余量、供应告警 |
| `mcp__android__android_provision` | 按 manifest 安装/修复（幂等、校验 sha256、走单槽） |
| `mcp__android__android_build` | 跑一个/多个 Gradle task，返回退出码与输出尾部 |

非 agent 入口（同一把锁）：`android-build <task...> [--cwd DIR] [--timeout ms]`。

## 资源上限

| 维度 | 值 | 原因 |
|---|---|---|
| 并发槽位 | **1** | 本机可用内存约 1 GB、swap 已用 9.7 GB；第二个 JVM 就是 OOM |
| 排队 | 最多 **3**，`flock -w 120` 拿不到即失败（退出码 75） | 失败要快，不要堆成雪崩 |
| 单次构建超时 | 20 分钟（默认） | 防止卡死占槽 |
| 优先级 | `nice 19` | 不抢前台 |
| CPU | `taskset -c 0-3` | 给 UI 留核 |
| JVM | `-Xmx1024m`、Metaspace 512m、`--max-workers=2`、`parallel=false` | 写进共享 `gradle.properties` |
| 不用 `RLIMIT_AS` | — | JVM 需要大段虚拟地址空间，`prlimit --as` 会让它起不来；内存靠 `-Xmx` + 单槽 |

`android_status` 的 `holder.json` 里记录了 owner（会话/调用方标签）、pid、开始时间，谁占着槽一目了然。

## aarch64 的现实边界

本机是 **aarch64 + proot**，无 x86 模拟：

- ✅ arm64 JDK + Gradle + Kotlin/JVM 编译、`test`、静态检查；
- ❌ 官方 Android SDK `build-tools`（aapt2/d8/zipalign）和 NDK 主机工具链都是 **linux-x86_64 ELF**，执行不了；manifest 里 `sdk`/`ndk` 默认关闭并写明原因；
- 真要打 APK：换成可信的 arm64 build-tools（并在 manifest 里 pin sha256），或交给远程 x86_64 构建机。

## 配置

| 变量 | 作用 |
|---|---|
| `DSH_ANDROID_ROOT` | 共享区根目录（默认 `/opt/android-toolchain`，不可写时回退 `$DSH_HOME/android-toolchain`） |
| `DSH_ANDROID_PROVISION=off` | 跳过 postinstall 供应 |
| `toolchain.manifest.json` | 组件、版本、来源、sha256、Gradle 默认参数——唯一供应链 |

`android-provision --pin --write` 会下载并回填 sha256；**发布前必须 pin**（release 工作流用 `--strict` 卡住）。

## 本地开发

```sh
node --test tests/*.test.mjs
node bin/android-provision.mjs --dry-run                 # 计划，不写盘
node bin/android-provision.mjs --manifest m.json --root /tmp/x --no-link   # 用假 manifest 演练
```

测试用本地 HTTP 服务 + 合成 tar.gz 覆盖完整供应链（下载 → sha256 → 解包 → 软链 → 启动器），不依赖外网、不碰 `/opt`。

## CI / CD

- `ci.yml`：Node 20/22 矩阵，跑 `node --test`，并对每个 enabled 组件做来源可达性检查。
- `release.yml`：打 `v*` tag → 测试 → `--verify-manifest --strict`（必须 pinned 且可达）→ `npm publish --provenance` → 生成 tarball 附到 GitHub Release。
- 需要在仓库 secrets 里配 `NPM_TOKEN`；公开仓库才有 provenance。

## 故障排查

| 现象 | 处理 |
|---|---|
| 会话里看不到 `mcp__android__*` | 先 `android-provision` 生成入口，**再重启 DSHA Web**（MCP 条目只在启动/重载时重新连接）；`android-status` 能跑说明入口在 PATH |
| `busy: true` / 退出码 75 | 别人占着槽或排队已满；看 `android_status` 的 holder/queue |
| `sha256 mismatch` | 上游重发了包；重新 `--pin --write` 并 review diff |
| `java is x86_64, not aarch64` | 装错了架构的 JDK，`android-doctor` 会直接报出来 |
| 供应失败但插件已装 | 手动 `android-provision`；网络受限时把包放进 `<root>/tmp` 并改 manifest 为 `file://` 来源 |
