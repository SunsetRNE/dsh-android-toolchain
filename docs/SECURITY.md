# 安全审计

范围：本仓库的下载点、脚本执行面、签名材料处理。逐项列出**校验方式与失败行为**，以及无法由本仓库消除的残余风险。

## 下载点

| 下载点 | 来源 | 完整性校验 | 失败行为 | 残余风险 |
|---|---|---|---|---|
| JDK 21.0.5+11 (aarch64) | Adoptium API | `toolchain.manifest.json` 的 sha256；未 pin 拒绝安装 | sha256 不匹配即中止，不落盘 | 上游重发需 `--pin --write` + 人工 review；信任 Adoptium |
| Gradle 8.10.2 | services.gradle.org | 同上 | 同上 | 同上 |
| cmdline-tools 11076708 | dl.google.com | `CMDLINE_TOOLS_SHA256`（`scripts/setup-apk.sh`） | 不匹配即 `die`，不导入 | Google 重发布同 build id 会让安装失败（需重新 pin，不会静默换包） |
| platform 35 / build-tools 35 | Google SDK 仓库（sdkmanager） | sdkmanager 校验仓库 manifest 的校验和 | sdkmanager 报错退出 | 本仓库未单独 pin；依赖 Google 签名仓库 + HTTPS |
| aapt2 16.0.0.4-4 | Termux 仓库 | `AAPT2_SHA256`，且索引解析出的**文件名必须等于** `aapt2_<AAPT2_VERSION>_aarch64.deb` | 不匹配或索引版本变化即 `die` | 需人工更新 `AAPT2_VERSION` + `AAPT2_SHA256` |
| aapt2 的依赖库（8 个 deb） | Termux 仓库 | 从 Packages 索引读取每个包的 `SHA256` 并校验 | 不匹配即 `die` | 索引本身经 HTTPS 获取；信任 Termux 仓库 |
| 插件 bundle（tarball） | GitHub Release | 用户核对 `SHA256SUMS`；DSH 安装器校验包结构 | 校验失败不导入 | 分发信任 GitHub；签名/校验由使用者执行 |

## 执行面

- 脚本**不含动态执行**：没有 `eval`、`curl … | sh`、`sh -c "$(...)"`；`setup-apk.sh` 只做下载、校验、解包（`tar` / `dpkg-deb`）。
- zip 解包使用固定 Python 片段，并对每个条目做**路径越界检查**；tar/zip 解包都在 `<root>/tmp` 下进行。
- broker 只 spawn 白名单命令（`gradle`、`java -jar apksigner.jar`、`sh` 用于测试），不把参数拼进 shell 字符串。
- 环境变量只通过显式 `source <root>/bin/env.sh` 生效，不写 `/etc/profile.d`，不改全局 PATH。
- 插件安装后的 postinstall 只跑 `android-provision --auto`（下载 + 校验 + 解包 + 写启动器），CI 与 `DSH_ANDROID_PROVISION=off` 时跳过。

## 签名材料

- 密码只以 `--ks-pass env:NAME` / `--key-pass env:NAME` 传给 `apksigner.jar` 的子进程环境：`ps`、日志、会话记录里都看不到。
- 配置来自 `<root>/signing.json`（建议 `chmod 600`）或 `ANDROID_*` 环境变量；工具**不接受**密码作为参数。
- 拒绝原地签名；默认输出 `<name>-signed.apk`，避免覆盖已签名产物。
- `android-doctor` 只显示配置路径与别名，不显示密码内容；缺配置时给出操作提示，不含密钥值。

## 已知不承诺

- 不对 Google / Termux / Adoptium 上游做独立签名验证，只做 sha256 固定与仓库信任。
- 不做多用户隔离（单设备单维护者场景），见 [README 的不支持列表](../README.md#不支持与不做)。
- 不保证 `keystore` 的备份与轮换；那是维护者流程，不在本仓库范围。

## 回归守卫

```sh
node --test tests/security.test.mjs
```

该测试断言：启用的组件必须 pin、`setup-apk.sh` 保留两个 pin 与索引校验、签名只走 `env:`、`bin/`+`src/`+`scripts/` 不出现 `eval`。
