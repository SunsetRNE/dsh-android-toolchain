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
                  # 可写时同名启动器也会写入 /usr/local/bin，任何会话 shell 直接可见
  gradle-home/    # GRADLE_USER_HOME：缓存 + gradle.properties（首次生成后不再覆盖）
  run/            # build.lock / holder.json / queue/  ← 单槽状态
```

工具链**不在** profile 里，也**不在**任何 workspace 里：插件升级不删 JDK，workspace 只是代码。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `mcp__android__android_status` | 共享区、已装组件、当前 holder 与排队者、上限、最近 5 次构建 |
| `mcp__android__android_doctor` | java/gradle 的**真实 ELF 架构**、版本、磁盘/内存余量、供应告警 |
| `mcp__android__android_provision` | 按 manifest 安装/修复（幂等、校验 sha256、走单槽） |
| `mcp__android__android_build` | 跑一个/多个 Gradle task，返回退出码与输出尾部 |
| `mcp__android__android_test` | 跑 Gradle 测试并汇总 JUnit XML：通过/失败/错误/跳过 + 失败用例名与信息 |
| `mcp__android__android_sign` | 用 release keystore + `apksigner.jar` 签名并验证，返回证书 SHA-256 |
| `mcp__android__android_install` | 把 APK 交给系统安装器（用户在设备上确认），可选回报当前已装版本 |

非 agent 入口（同一把锁）：`android-build <task...> [--cwd DIR] [--timeout ms]`、`android-test [...]`（默认跑 `test` 并输出 JUnit 汇总 + 失败清单）。

## 资源上限

| 维度 | 值 | 原因 |
|---|---|---|
| 并发槽位 | **1** | 本机可用内存约 1 GB、swap 已用 9.7 GB；第二个 JVM 就是 OOM |
| 排队 | 最多 **3**，`flock -w 120` 拿不到即失败（退出码 75） | 失败要快，不要堆成雪崩 |
| 单次构建超时 | 20 分钟（默认） | 防止卡死占槽 |
| 优先级 | `nice 19` | 不抢前台 |
| CPU | `taskset -c 0-3` | 给 UI 留核 |
| JVM | `-Xmx1536m`、Metaspace 512m、`--max-workers=2`、`parallel=false` | 写进共享 `gradle.properties`；AGP 比纯 JVM 编译更吃内存 |
| 不用 `RLIMIT_AS` | — | JVM 需要大段虚拟地址空间，`prlimit --as` 会让它起不来；内存靠 `-Xmx` + 单槽 |

`android_status` 的 `holder.json` 里记录了 owner（会话/调用方标签）、pid、开始时间，谁占着槽一目了然。

### 签名（release）

签名材料**不通过工具参数传递**（参数会进对话记录），只从共享区配置或环境变量读取：

```json
// /opt/android-toolchain/signing.json   (chmod 600)
{
  "keystore": "/root/keys/release.jks",
  "alias": "release",
  "storePasswordFile": "/root/keys/release.pass"
}
```

或环境变量：`ANDROID_KEYSTORE`、`ANDROID_KEY_ALIAS`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_PASSWORD`（后者缺省时复用前者）。

首次配置（在设备上自己执行，密码只输入一次、不要发到对话里）：

```sh
keytool -genkeypair -keystore /root/keys/release.jks -alias release \
  -keyalg RSA -keysize 2048 -validity 3650 -storetype PKCS12 -dname "CN=Your Name"
chmod 600 /root/keys/release.jks
printf '%s\n' '你的store密码' > /root/keys/release.pass && chmod 600 /root/keys/release.pass
cat > /opt/android-toolchain/signing.json <<'JSON'
{"keystore":"/root/keys/release.jks","alias":"release","storePasswordFile":"/root/keys/release.pass"}
JSON
chmod 600 /opt/android-toolchain/signing.json
```

```sh
android-sign app-debug.apk --out app-release.apk
# 等价 MCP：mcp__android__android_sign { apk, out }
```

- 密码只以 `--ks-pass env:ANDROID_KS_PASS` 传给 apksigner，`ps` 和日志里看不到
- 拒绝原地签名，输出默认 `<name>-signed.apk`
- 先签后验，返回 `verified` 与 `certSha256`（`apksigner verify --print-certs`）
- 未配置时返回可操作提示（指向 `signing.json`），提示里不含任何密钥值
- `android-doctor` 会显示 `apksigner.jar` 是否存在、签名配置是否就绪（只显示路径与别名）

### 安装（系统安装器）

```sh
android-install app-signed.apk --package com.example.hello
# 等价 MCP：mcp__android__android_install { apk, packageName }
```

- 走 DSHA App 桥的 `/app/install`，把 APK 交给**系统安装器**；`OK: installer` 只表示“已请求”，安装与否由用户在设备上确认
- 之后工具会附带 `installedNow`（`/app/apps?q=<包名>` 的结果），但用户还没确认时它仍是旧版本——这是预期，不是失败
- `NO_PERMISSION`：DSHA 没有「安装未知应用」授权（系统设置页已打开），允许后再请求一次，不要循环重试
- `NO_NOTIFICATION`：通知被关且 DSHA 不在前台，安装请求无法呈现；打开通知或把 DSHA 切前台
- 不支持 `.apks`/`.xapk` 分包；不能经桥覆盖安装 DSHA 自身（会结束 App 与全部会话）

### 测试汇总

`android_test`（或 `android-test`）跑完 Gradle 后读取 `**/build/test-results/**/*.xml`，返回：

```json
{"tests": 12, "failures": 1, "errors": 0, "skipped": 2,
 "failing": [{"suite": "com.example.CalcTest", "classname": "...", "test": "adds", "kind": "failure",
              "message": "expected:<2> but was:<3>"}]}
```

- 不使用控制台输出做判断，避免 Gradle 彩色/换行带来的误判
- 失败清单最多 20 条，每条信息截断到 500 字符
- 无测试结果（`NO-SOURCE`）时返回全 0，而不是报错
- 退出码仍是 Gradle 的，CI 可直接用

### 构建历史

每次构建（含排队被拒）、每次安装请求都会追加到 `<root>/run/history.jsonl`（最多 200 条，超过 512 KiB 自动裁剪）。`kind` 区分 `build` 与 `install`：

```json
{"id":"m3k2p1-4321","owner":"mcp:4321","cmd":"gradle assembleDebug","cwd":"/tmp/app",
 "startedAt":"2026-11-23T18:20:00Z","finishedAt":"...","waitedMs":107,"durationMs":4355,
 "exitCode":0,"status":"ok"}
```

- `android_build` 返回 `buildId`；CLI 的收尾行是 `[android-build] <id> exit <code> in <n>s`，可直接和日志对齐
- `status` 取值：构建 `ok` / `failed` / `timeout` / `busy`（等锁超时）/ `queue-full`（排队已满）/ `error`（无结果）；安装 `requested` / `blocked`
- 安装记录只存路径、包名、模式与结果码，不存文件内容
- `android_status.recent` 给最近 5 条，`android-doctor` 给最近 3 条 + Gradle daemon 数量

## 已验证（本机 aarch64 proot）

- Temurin **21.0.5+11 (aarch64)** + Gradle **8.10.2**：`android-build build` 跑通一个真实 Java 项目（`BUILD SUCCESSFUL`，15 s）
- 同一个构建经 `mcp__android__android_build` 调用成功（MCP 客户端 → broker → 单槽 → Gradle，2.7 s 增量）
- `android-doctor` 报告 `java arch = aarch64`、槽位空闲

## 真打 APK（aarch64，已实测）

官方 build-tools 的 `aapt2` 只有 linux/osx/windows **x86_64** classifier，而 AGP 总是从 Google Maven 取它——这是 aarch64 上唯一真正卡住的地方。把它换掉就行，其余（`d8`/R8、`zipalign`、签名）都是 JVM 里的 Java，能直接跑。

```sh
sh scripts/setup-apk.sh        # 一次性：cmdline-tools + platform 35 + build-tools 35 + arm64 aapt2
android-build assembleDebug --cwd <你的 Android 项目>
```

`setup-apk.sh` 做的事：

1. 安装 Android `cmdline-tools`（纯 Java，arm64 可跑）→ `<root>/sdk/cmdline-tools/latest`
2. `sdkmanager` 安装 `platforms;android-35` 与 `build-tools;35.0.0`（接受 licenses；build-tools 里的原生工具是 x86_64，我们不使用）
3. 从 Termux 官方仓库取 **aarch64 aapt2**（`16.0.0.4-4`，sha256 固定）及其依赖库，装上 `bin/aapt2` 包装器：
   `/system/bin/linker64` + `LD_LIBRARY_PATH=<prefix>/lib`（Termux 的 aapt2 是 bionic 链接，proot 里必须这样跑）
4. `android-build` 自动追加 `-Pandroid.aapt2FromMavenOverride=<root>/aapt2/current/bin/aapt2`

本机实测（2026-11-23）：

| 项 | 值 |
|---|---|
| 项目 | 最小 `com.android.application`（compileSdk 35 / minSdk 24，无第三方依赖） |
| 工具 | AGP **8.7.3**、Gradle **8.10.2**、JDK **21.0.5**、aapt2 `2.20-android-16.0.0_r4` |
| 结果 | `BUILD SUCCESSFUL`，冷构建 2 min 1 s（含依赖下载），产物 `app-debug.apk` 5.6 KB |
| 校验 | `aapt2 dump badging` 显示 `package=com.example.hello`、`minSdk 24`、`targetSdk 35`；`apksigner.jar verify` 通过 |

已知无害噪音：AGP 日志会出现 `AAPT2 bin Daemon #0: Unexpected error output: WARNING: linker: ... ld.config.txt`——这是 bionic loader 的提示，构建不受影响。

信任边界：aapt2 的 `.deb` 在脚本里按 sha256 校验；依赖库来自同一个 Termux 签名仓库。升级 aapt2 必须同时改 `AAPT2_VERSION` 与 `AAPT2_SHA256`（`AGENTS.md` 的发布清单里有这条）。

仍然不建议的路：把官方 build-tools 整个塞进来（x86_64 原生工具会 `Exec format error`），或往 `/etc/profile.d` 写环境变量（bash 工具不读 rc）。NDK（C/C++）依旧不可用，需要远程 x86_64 构建机。

## aarch64 的现实边界

本机是 **aarch64 + proot**，无 x86 模拟：

- ✅ arm64 JDK + Gradle + Kotlin/JVM 编译、`test`、静态检查；
- ✅ **AGP 打 APK**：唯一缺的是 aapt2，`scripts/setup-apk.sh` 用 Termux 的 arm64 aapt2 + `android.aapt2FromMavenOverride` 解决（见上一节实测）；
- ❌ 官方 SDK `build-tools` 里的其它**原生**工具（`aidl`、`zipalign` 等 x86_64）和 NDK 主机工具链仍然执行不了；manifest 里 `sdk`/`ndk` 默认关闭并写明原因（SDK 由 `setup-apk.sh` 以 Java 工具方式提供）；
- ❌ 用 `aidl` 的项目、需要 NDK 的原生模块：交给远程 x86_64 构建机。

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
- `smoke-arm64.yml`：在 **`ubuntu-24.04-arm`** 上跑两个 job——
  - `jvm`（阻塞）：供应工具链 → `setup-apk.sh --no-aapt2` → 编译/运行 `examples/junit-project` → 断言 java 是 aarch64、platform 与 apksigner 就位；
  - `apk-qemu`（建议性，`continue-on-error`）：额外用 qemu-user 执行 Google Maven 的 x86_64 aapt2，尝试**整包构建** `examples/hello-apk`。
  - 为什么要分：我们随包提供的 arm64 aapt2 是 Termux 的 **bionic** 构建，需要 `/system/bin/linker64`，GitHub 的 Ubuntu runner 没有 Android 用户态；真机上的 APK 路径由 `sh scripts/smoke.sh` 兜底。
- 本地等价命令：
  ```sh
  sh scripts/smoke.sh          # 真机全量（含 APK）
  sh scripts/smoke.sh --jvm    # 纯 Linux 可跑的基线（无 APK）
  SMOKE_WAIT_MS=900000 sh scripts/smoke.sh   # 槽位忙时排队更久
  ```
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
| `aapt2 ... Exec format error` | 用的是 build-tools 里的 x86_64 aapt2；跑 `sh scripts/setup-apk.sh` 并确认 `android-build` 注入了 override |
| `AAPT2 ... ld.config.txt` 警告 | bionic loader 的无害提示，构建正常 |
| `sdkmanager` 报找不到 java | 共享区没有 JDK；先 `android-provision`（`setup-apk.sh` 会检查） |
| `apksigner.jar not found` | 没跑过 `scripts/setup-apk.sh`，或 build-tools 缺失 |
| 签名返回 `busy` / 退出码 75 | 单槽被别的会话占着；用 `--wait <ms>` 排更久，或看 `android_status` 的 holder |
| `signing is not configured` | 按提示建 `<root>/signing.json`（chmod 600）或设置 `ANDROID_*` 环境变量；**不要把密码发到对话里** |
