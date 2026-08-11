# RepoMind v0.18.0 加密可移植性

## 目标

v0.18.0 在逻辑导出和物理备份文件离开 RepoMind 常规数据目录时对其进行保护。
它扩展现有的替换导入及同 Project ID 恢复契约；不会改变这些契约，也不会引入
合并导入。

实现采用严格的 `repomind-encrypted-archive` version 1 JSON 信封、
AES-256-GCM 认证加密，以及参数为 `N=32768`、`r=8`、`p=1`、密钥长度
32 字节的 scrypt。每个归档使用随机的 16 字节盐和 12 字节 IV。用途以及明文
格式、版本、字节长度和 SHA-256 都属于认证元数据。口令必须至少包含 12 个
UTF-8 字节。

## 凭据边界

CLI 从不接受口令值作为参数。`--encrypt` 读取
`REPOMIND_ARCHIVE_PASSPHRASE`；`--passphrase-env <name>` 可选择其他环境变量。
当默认变量存在时，导入和恢复会自动使用它。Core 库调用方传入内存中的
`passphrase` 选项，并负责获取和清除该值。

操作结果和验收报告不包含口令值、盐、IV、Tag 和密文。归档本身必然包含盐、IV、
Tag 和密文。RepoMind 不会持久化或恢复密码。

## 失败契约

逻辑解密和信封验证发生在 SQLite 替换事务之前。物理解密和认证元数据验证发生在
创建临时 SQLite 文件之前。因此，密码错误、密文或 Tag 被修改、认证元数据被修改，
以及用途不匹配，都必须使目标仓库保持不变。

加密恢复仅将解密后的 SQLite 写入新创建的操作系统临时目录；在支持 POSIX 模式时
请求 0600 权限，并在 `finally` 中递归删除该目录。活动数据库及其持久化的恢复前
回滚快照仍是本地明文存储；归档加密不是全盘加密。

## 可重新构建的验收

从干净的 RepoMind commit 运行，并使用新的外部工作区：

```powershell
$env:REPOMIND_ARCHIVE_PASSPHRASE = Read-Host "Acceptance passphrase" -MaskInput
npm run bench:encrypted-portability -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v018-encrypted-<new-id> `
  --repeat 5 `
  --require-clean
Remove-Item Env:REPOMIND_ARCHIVE_PASSPHRASE
```

运行器拒绝使用已存在的工作区。它会将选定 commit 克隆两次，使用隔离的数据目录，
预置确定性的 L1-L3 仓库数据，并测量明文及加密的导出、导入、备份和恢复。
验收门槛覆盖格式兼容性、完整往返、已知明文不存在、错误密码拒绝、密文/Tag/AAD/
用途篡改、零写入行为、单文件加密备份、临时明文清理以及报告不含凭据。

JSON 和 Markdown 报告保留实现 commit、工作树变更状态、克隆的数据 commit、
操作系统、硬件、产物哈希、数据集大小、原始时间样本、百分位数和实测加密开销。
正式发布结果必须使用 `--require-clean`；有变更的开发运行可用于诊断，但不能作为
发布证据。

现有的 `bench:package-smoke` 运行器还会通过已安装的 npm tarball 测试加密导出、
导入、备份和恢复。它在进程内生成新口令，仅通过子进程环境传递，并检查包报告不含
该口令。常规三平台 CI 矩阵在 Ubuntu、Windows 和 macOS 上运行这一已安装包证明。

## 正式干净 commit 结果

正式 Windows 运行于 2026-07-29 在干净 commit
`bcf88224d52ac362a07d98a22e920f78c2a6f4c4` 上通过全部 29 项门槛。
报告记录 `implementationDirty=false` 和 `requireClean=true`。其确定性数据集
包含 40 条 L1 Memory、两篇 L2 叙述和一份 L3 Profile。

本机五次采样的加密开销 P50 分别为：逻辑导出 93.267 ms、逻辑导入 dry-run
96.09 ms、物理备份 106.503 ms、物理恢复 dry-run 159.485 ms。逻辑导出的
明文/加密大小为 106,069/142,027 字节，物理备份为 462,848/617,723 字节。
这些是单机测量值，不是通用性能目标。

产物保留在仓库外部：

```text
D:\data\code\project\repomind-test\v018-encrypted-portability-formal-bcf8822-01
```

- JSON 报告 SHA-256：
  `a21a9245b22589cf188c16f772fb1b0b8327865be9a5e6a6e21d701db4b77946`
- Markdown 报告 SHA-256：
  `47824976a916b9471a5aa8f4308886aad3857907daab439e6df317af6072b827`

## 干净 commit 跨平台结果

[GitHub Actions 运行 30464400835](https://github.com/Nei-Xin/repomind/actions/runs/30464400835)
在 `bcf8822` 上用时 7 分 4 秒成功完成。Ubuntu、Windows、macOS、源码覆盖率和
对比基准全部通过。每个平台都运行了类型检查、构建、完整测试套件、Agent 固件检查，
以及包含 14 项门槛的已安装 tarball smoke；其中包括使用仅存在于环境变量中的
生成口令测试加密逻辑和物理可移植性。

五条 Actions 警告是 GitHub 维护的 Action 所产生的上游 Node.js 20 弃用通知；
GitHub 已强制这些 Action 使用 Node.js 24。它们不代表 RepoMind 测试、包或运行时失败。

随后，[GitHub Actions 运行 30465296786](https://github.com/Nei-Xin/repomind/actions/runs/30465296786)
在干净证据 commit `7b55572b3fd54b39cbcf4668e4247b5702749ad4` 上独立通过
相同的五个 job，用时 6 分 39 秒。这在仅版本变更的发布 commit 之前关闭了
干净证据发布门槛。

## 正式发布和标签结果

发布 commit `60c8a29ecd5ec8076c30e8669e27f803ac78d9ba` 更新了包版本、
Changelog、发布措辞和已发布 Schema 清单。附注标签 `v0.18.0` 指向该 commit。

[GitHub Actions 标签运行 30468234422](https://github.com/Nei-Xin/repomind/actions/runs/30468234422)
用时 7 分 17 秒成功完成。Ubuntu、Windows、macOS、覆盖率和对比任务均在该标签
commit 上通过，且独立于成功的主分支发布运行 `30467505192`。

## 剩余边界

本次发布没有增加合并导入、自动调度、远程上传、云同步、硬件支持的密钥、密钥轮换、
密钥托管、MCP 恢复工具或活动本地数据库加密。这些功能需要单独的策略和威胁模型。
