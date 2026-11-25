# 从零到 APK：runbook

面向一台**全新的 aarch64 环境**（Android proot 容器或 arm64 服务器）：按顺序做完就能编译出 APK、跑单测、签名并装到手机上，全程不需要读源码。

> 每一步都有「期望输出」和「失败分支」。遇到不在表里的现象，先看 [README](../README.md) 的故障排查表，再跑 `android-doctor` 把状态贴出来。

## 0. 前置检查

```sh
uname -m          # 期望 aarch64
node -v           # 期望 >= 20
id -u             # 0，或确认 $DSH_HOME 可写（/opt 不可写时自动回退）
```

| 结果 | 处理 |
|---|---|
| `x86_64` | 本工具链的 JDK/Gradle 是 arm64 的，**未在 x86_64 验证**；换设备或自行替换 JDK |
| Node < 20 | 升级 Node（包内 `engines.node` 要求 ≥ 20） |
| 无网络 | 供应需要下载约 350 MB；受限网络见第 2 步的 `file://` 方案 |

## 1. 安装 bundle

任选一种：`dsha-plugin import dsh-android-toolchain-<version>.tgz`（先核对 `SHA256SUMS`），或 Plugins 页 → install_bundle。

```sh
sha256sum -c SHA256SUMS
dsha-plugin import dsh-android-toolchain-<version>.tgz
```

- 安装脚本会被请求批准；批准后 `postinstall` 立即供应 JDK + Gradle。不想现在下载：`DSH_ANDROID_PROVISION=off`，之后手动第 2 步。
- `CI=true` 时 postinstall 自动跳过（CI 不供应工具链）。
- **重启 DSHA Web**，MCP 条目 `android` 才挂载；重启后在 Plugins 页确认版本号和详情页（`docs/DETAIL.zh.md`）。
- 只在重启后，agent 才看得到 `mcp__android__*` 工具。

## 2. 供应工具链

```sh
android-provision          # 幂等，失败可重跑
android-doctor | grep -m1 '"arch"'   # 期望 "arch": "aarch64"
```

期望：`jdk@21.0.5+11: installed`、`gradle@9.1.0: installed`、`launchers: <root>/bin`。

| 失败分支 | 处理 |
|---|---|
| `sha256 mismatch` | 上游重发了包：`android-provision --pin --write` 后 review diff；**不要**用 `--allow-unpinned` 上生产 |
| 下载失败/断网 | 把归档放进 `<root>/tmp/`，或改 manifest 为 `file://` 来源 |
| `/opt` 不可写 | `DSH_ANDROID_ROOT=$DSH_HOME/android-toolchain android-provision` |
| `java is x86_64, not aarch64` | 装错架构的 JDK；删掉 `<root>/jdk` 重跑第 2 步 |
| 供应成功但工具不可见 | 入口在 `<root>/bin`；用 `source <root>/bin/env.sh` 或直接用 `android-build` |

## 3. APK 工具链（真机必需）

```sh
sh scripts/setup-apk.sh
<root>/aapt2/current/bin/aapt2 version   # 期望输出含 aapt 的一行
```

它做三件事：cmdline-tools（纯 Java）→ `platforms;android-35` + `build-tools;35.0.0` → Termux 的 **arm64 aapt2** 包装器（`/system/bin/linker64` + 私有 lib）。

| 失败分支 | 处理 |
|---|---|
| `aapt2 ... Exec format error` | 用的是 Google Maven 的 x86_64 aapt2：必须通过 `android-build`/MCP 构建（会自动注入 `-Pandroid.aapt2FromMavenOverride=`） |
| `aapt2 did not run` | 没有 `/system/bin/linker64`（非 Android 主机）→ 这是纯 Linux 环境的固有限制，APK 只能在真机验证 |
| `sdkmanager` 找不到 java | 共享区没有 JDK，先回第 2 步 |
| 想省磁盘 | 只用 `--no-aapt2` 装 SDK，APK 仍打不出来（仅 CI 基线用） |

## 4. 第一个 APK

```sh
cp -r examples/hello-apk ~/myapp && cd ~/myapp
android-build assembleDebug --cwd ~/myapp
ls -l app/build/outputs/apk/debug/app-debug.apk
```

期望 `BUILD SUCCESSFUL`；冷构建约 2 分钟（含 AGP 下载），热构建几十秒。

| 失败分支 | 处理 |
|---|---|
| `SDK location not found` | 没跑第 3 步，或项目缺 `local.properties`（`sdk.dir=<root>/sdk`） |
| `AAPT2 ... ld.config.txt` 警告 | bionic loader 的无害提示，构建正常 |
| `busy: true` / 退出码 75 | 槽位被占：`android-status` 看 holder，或加 `--wait <ms>` |
| 内存不足 / 进程被杀 | 别人的构建正在跑；等槽位空闲，或降低 `-Xmx`（见 README 上限表） |

MCP 等价调用（agent 场景）：先 `android_status`，再 `android_build {task: "assembleDebug", cwd: "..."}`；构建永远走单槽，不要直接 `gradle`。

## 5. 单测

```sh
android-test --cwd ~/myapp
```

输出里有 `tests / failures / errors / skipped` 和失败用例名（读 JUnit XML，不解析控制台）。退出码就是 Gradle 的。

## 6. 签名（两种方式，密码都不进仓库/对话）

**A. 工具链签名（推荐，适合 agent）**

```sh
keytool -genkeypair -keystore /root/keys/release.jks -alias release \
  -keyalg RSA -keysize 2048 -validity 3650 -storetype PKCS12 -dname "CN=Your Name"
chmod 600 /root/keys/release.jks
printf '%s\n' '你的store密码' > /root/keys/release.pass && chmod 600 /root/keys/release.pass
cat > <root>/signing.json <<'JSON'
{"keystore":"/root/keys/release.jks","alias":"release","storePasswordFile":"/root/keys/release.pass"}
JSON
chmod 600 <root>/signing.json

android-sign app/build/outputs/apk/debug/app-debug.apk --out app-release.apk
```

期望 `verified=true` 和 `certSha256`。

**B. 项目内签名（IDE/CI 构建 release）**：见 [examples/signing](../examples/signing/README.md)（`signing.gradle` + `keystore.properties`，后者必须 gitignore）。

| 失败分支 | 处理 |
|---|---|
| `signing is not configured` | 建 `<root>/signing.json` 或设 `ANDROID_*` 环境变量 |
| 签名 `busy`/75 | 槽位被占，用 `--wait` 或等 `android_status` 空闲 |
| `verify failed` | 换了 keystore 或 APK 被改过；重新签，不要复用旧签名文件 |

## 7. 装到手机

```sh
android-install app-release.apk --package com.example.hello
```

`OK: installer` 只表示**请求已提交**，要在手机上确认；随后工具会回报当前已装版本（确认前仍是旧版本，属正常）。若返回 `NO_PERMISSION`，按提示给 DSHA 开「安装未知应用」，再请求一次（不要循环重试）。

## 8. 多 root（可选）

```sh
android-provision --root /opt/android-toolchain-alt --register --label alt --reuse-from default
android-status --all
android-build assembleDebug --root alt --cwd ~/myapp
```

两个 root 各有独立锁与 limits，可以同时构建；但同一台设备上两个 JVM 会抢内存（可用约 1 GB），并行前先确认余量。

## 9. 验收清单

- [ ] `android-doctor`：`java.arch = aarch64`，`warnings` 为空
- [ ] `aapt2 version` 有输出
- [ ] `assembleDebug` 成功，APK 存在；`aapt2 dump badging <apk>` 的包名/minSdk/targetSdk 正确
- [ ] `android-test`：`tests > 0`、`failures = 0`
- [ ] `android-sign`：`verified = true`，`certSha256` 与预期一致
- [ ] `android-install` 后手机上能启动
- [ ] `android-status` / `--all` 里没有残留 holder，队列为空

全部通过即完成“新设备从零到 APK”。
