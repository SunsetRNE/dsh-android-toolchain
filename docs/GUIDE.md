# Android/JVM toolchain — quick guide

本文件由 MCP 工具 `android_guide` 按 `## <topic>` 分节按需返回；也可以直接当速查表读。
完整细节在 [RUNBOOK](RUNBOOK.md)、[SECURITY](SECURITY.md)、[UPGRADING](UPGRADING.md)、[PERFORMANCE](PERFORMANCE.md) 和仓库 README。

## overview

- 共享工具链在 `<root>`（默认 `/opt/android-toolchain`）：JDK + Gradle + SDK + arm64 aapt2，所有会话共用。
- 构建必须走 **单槽**：用 MCP 的 `android_build` / `android_test`，或 CLI `android-build` / `android-test`。**不要**直接跑 `gradle`/`gradlew`——会绕过排队和资源限制。
- 先 `android_status` 看槽位和已装组件；失败时结果里带 `hints`，按提示走。
- 多 root、签名、安装、排查见下面对应 topic。

## build

```jsonc
// MCP
{"name":"android_build","arguments":{"task":"assembleDebug","cwd":"/path/to/project"}}
{"name":"android_test","arguments":{"cwd":"/path/to/project"}}
```

- CLI：`android-build assembleDebug --cwd <项目>`；测试 `android-test --cwd <项目>`。
- 常用参数：`tasks`（多个任务）、`args`（额外 Gradle 参数）、`timeoutMs`、`waitMs`、`owner`（槽位记录里的标签）、`root`（选另一套工具链）。
- 返回：`buildId`、`exitCode`、`busy`、`timedOut`、`waitedMs`、`durationMs`、输出尾部；失败时带 `hints`。
- 退出码 75 / `busy: true` = 槽位被占或排队已满，看 `android_status` 的 holder/queue，或加大 `waitMs`。

## roots

```sh
android-provision --root /opt/android-toolchain-alt --register --label alt --reuse-from default
android-status --all
android-build assembleDebug --root alt --cwd <项目>
```

- 每个 root 有独立锁与 limits，可同时构建；注册表在 `<root>/roots.json`（`DSH_ANDROID_REGISTRY` 可改）。
- MCP 传 `root`（label 或绝对路径）；`android_status {all:true}` 汇总全部 root。
- 代价是内存：两个 root 同时构建 = 两个 JVM，手机上先确认余量。

## limits

```json
// <root>/limits.json 或 DSH_ANDROID_LIMITS 指向的文件
{"waitMs": 300000, "maxQueue": 5, "timeoutMs": 1800000, "nice": 19, "cpus": "0-3"}
```

- 默认：等锁 120 s、排队 3、单次 20 min、nice 19、`cpus 0-3`。
- 非法值不生效也不中断构建：保留默认并在 `android_status.limitWarnings` / doctor 里报告。
- 改完下一次构建即生效，不需要重启；槽数固定每 root 1 个。

## sign

```sh
android-sign app-debug.apk --out app-release.apk     # 需要 <root>/signing.json 或 ANDROID_* 环境变量
```

- 密码只从 `<root>/signing.json`（chmod 600）或环境变量读取，**不要**写进对话/参数。
- 先签后验，返回 `verified` 与 `certSha256`；拒绝原地签名。
- 项目内签名模板见 `examples/signing/`（`signing.gradle` + `keystore.properties`）。

## install

```sh
android-install app-release.apk --package com.example.hello
```

- 走系统安装器，用户在手机上确认；`OK: installer` 只代表请求已提交。
- `NO_PERMISSION`：给 DSHA 开「安装未知应用」后再请求一次；`NO_NOTIFICATION`：打开通知或把 DSHA 切前台。
- 不能经桥覆盖安装 DSHA 自身；不支持 `.apks`/`.xapk`。

## troubleshooting

- 先跑 `android-doctor`（`--full` 看 Gradle 版本，`--cache` 实测缓存体积并给清理建议）。
- 构建失败看结果里的 `hints`：SDK 未装、aapt2 架构、OOM、依赖解析、minSdk 冲突、签名凭据等都有对应动作。
- 槽位卡住：`android-status` 看 holder（owner/pid/开始时间）；必要时等它超时或找占用者。
- MCP 工具消失：`android-provision` 确认启动器在，再重启 DSHA Web。
- 更长的分支表见 README 的「故障排查」和 RUNBOOK 每一步的失败分支。

## docs

- `docs/RUNBOOK.md`：从零到 APK 的完整步骤与验收清单。
- `docs/SECURITY.md`：下载点校验、执行面、签名材料与残余风险。
- `docs/UPGRADING.md`：插件/工具链升级与回滚、DSH 兼容矩阵。
- `docs/PERFORMANCE.md`：冷/热构建基线、阈值与重新基线。
- `README.md`：资源上限、MCP 工具表、aarch64 现实边界、不支持项。
