# 升级与回滚

核心约定：**插件（profile 里的 bundle）与工具链（`/opt/android-toolchain`）是两件事**。升级插件不碰工具链，升级工具链不重装插件——所以两边都能单独回滚。

## 1. 插件（bundle）升级

```sh
sha256sum -c SHA256SUMS
dsha-plugin import dsh-android-toolchain-<new>.tgz     # 只生成预览，不安装
# 方式 A：Plugins 页确认该版本
# 方式 B（维护者/自动化）：复用 App 的入口
python3 /root/.dsh/plugin-manager.py install-preview <previewId> <confirmationSha256>
# 输出 "application": "restart-required" 后：
# 重启 DSHA Web
```

验证：

```sh
dsha-plugin list                       # 版本号
node <plugin-src>/bin/android-status.mjs --all
mcp__android__android_status {all: true}   # 新会话里
```

**回滚**：

```sh
dsha-plugin rollback dsh-android-toolchain
# 重启 DSHA Web
```

- 回滚只回退插件文件与 profile 条目，`<root>`（JDK/Gradle/SDK/构件、构建历史、limits）原样保留。
- 反向也成立：卸载/升级插件不会删除工具链（工具链不在 profile、不在 workspace）。

> 发布前建议在维护窗口实际演练一次 `rollback`：本仓库的发布清单目前只验证了“安装/升级”方向，回滚命令本身未在本机执行过（会改动当前 profile，不适合在会话中直接跑）。

## 2. 工具链组件升级

```sh
# 1) 改 toolchain.manifest.json 的 version / source / sha256
node bin/android-provision.mjs --pin --write            # 下载并回填 sha256
node bin/android-provision.mjs --verify-manifest --strict
node bin/android-provision.mjs                          # 安装到 <root>/<comp>/<new-version>
```

行为：

- 新版本装进独立目录（`jdk/21.0.5+11` 这种内容寻址路径），**旧版本目录保留**；
- `current` 软链切到新版本，启动器与 `JAVA_HOME` 都指向 `current`；
- 供应幂等：失败可重跑，不会留下半装的 `current`（先装完再切链）。

**回滚**：把 `current` 指回旧版本目录，然后确认：

```sh
ls <root>/jdk/                 # 看还有哪些版本
ln -sfn <old-version> <root>/jdk/current      # gradle 同理
node bin/android-doctor.mjs | grep -m1 '"arch"'
sh scripts/smoke.sh --jvm                     # 换 JDK 大版本时跑一次
```

回滚工具链不需要重启 Web：每次构建都现算 `JAVA_HOME=<root>/jdk/current`，下一次调用即生效。

**当前版本记录（2026-11-25）**：Gradle **9.1.0**（JDK 21.0.5+11 满足其 JDK 17+ 要求，AGP 8.7.3 与纯 Java 示例均已验证）。构建时 AGP 8.7.3 会提示使用了 Gradle 10 将移除的 API——升级到 Gradle 10 前需要同步升 AGP，届时按上面的流程重新验证。

## 3. DSH 升级

- 兼容性声明：`package.json` 的 `engines.dsh = ">=0.2.2-rc.5"`——这是**最低基线**，更低版本不测试、不承诺；DSH 安装器会在安装/启用时校验，不满足直接拒绝。
- 已验证矩阵（**只记录真实跑过的版本**）：

  | DSH | 验证范围 | 日期 |
  |---|---|---|
  | 0.2.2-rc.5 | 供应 + `--jvm` smoke + 真机 APK + MCP 接线（0.6.0 / 1.0.0 / 1.1.0） | 2026-11-24 |

- **只向上维护**：每次 DSH 升级后按 [RUNBOOK](RUNBOOK.md) 重跑一遍（供应 → `--jvm` smoke → 设备 APK → MCP 调用），通过才在矩阵里追加一行；不通过就把 `engines.dsh` 收紧到最后可用版本并记录原因。
- 不测试更低版本，也不为它们做兼容分支。
- 插件用的是 MCP stdio + `shellEnv` facts + bundle patch，这三样在 DSH 各版本间的契约变化是主要风险；升级后先跑 `--jvm` smoke。

## 4. 一次升级不丢数据的保证

| 操作 | 工具链 | 构建历史 | limits/签名配置 | 会话 |
|---|---|---|---|---|
| 插件升级/回滚 | 不动 | 不动 | 不动 | 重启 Web 后继续 |
| 工具链组件升级 | 新增版本，旧版保留 | 保留（追加） | 不动 | 不重启 |
| 多 root 迁移 | 用 `--reuse-from` 复用归档 | 各 root 独立 | 各 root 独立 | 不重启 |
