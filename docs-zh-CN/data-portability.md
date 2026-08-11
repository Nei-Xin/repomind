# 数据导出、备份与恢复

RepoMind 有意提供两种独立的可移植机制。逻辑导出将仓库知识迁移到另一个已初始化仓库；物理备份恢复同一 Project ID 的精确 SQLite 状态。v0.18 在保留现有明文格式的同时，为两类归档加入可选加密。

## 逻辑导出格式

```powershell
repomind export --output D:\backups\repository.json --json
```

JSON envelope 标识 `repomind-repository-export`、格式版本 2、来源 Project ID、数据库 schema 版本、导出时间、固定表数据和确定性 SHA-256 checksum。RepoMind 会拒绝未知或缺失的表、未知或缺失的列、不支持的版本以及 checksum 变化。目标文件及其父目录必须显式指定；现有文件绝不会被覆盖。

导出内容包括 Session、Evidence、L1 Memory、治理历史、关系、Host-run 历史、L2 Narrative、L3 Profile、L4 Skill Candidate、审查 Audit 和全部来源链接。版本 1 导出仍可读取，导入时 L4 表为空。以下内容不会导出：

- checkout 路径，因为它们只属于一台机器；
- FTS 表，因为导入时会重建；
- 向量嵌入，因为它们由已配置提供方派生；
- schema 迁移记录，因为目标使用其已安装 schema。

导出要求不存在 open Session 或 running Host Run。RepoMind 会扫描每个字符串中的已知 credential 模式。默认情况下，发现敏感内容会阻止写入。检查并接受风险后，`--allow-sensitive` 会记录操作者显式允许导出；它不会静默修改归档或导出数据。

## 加密归档

在进程环境中设置 passphrase，创建归档时使用 `--encrypt` 显式启用：

```powershell
$env:REPOMIND_ARCHIVE_PASSPHRASE = Read-Host "Archive passphrase" -MaskInput
repomind export --output D:\backups\repository.enc.json --encrypt --json
repomind backup --output D:\backups\repomind.db.enc --encrypt --json
Remove-Item Env:REPOMIND_ARCHIVE_PASSPHRASE
```

Passphrase 至少包含 12 个 UTF-8 字节。它不能通过命令行参数提供，也绝不会出现在命令输出中。若要使用 Secret manager 专用变量，请添加 `--passphrase-env MY_ARCHIVE_SECRET`；该 flag 只给出变量名，绝不包含变量值。

加密 JSON envelope 为 `repomind-encrypted-archive` 格式版本 1。它使用 AES-256-GCM、随机 16 字节 salt、随机 12 字节 IV 和 16 字节 authentication tag。32 字节 key 通过 scrypt 派生（`N=32768`、`r=8`、`p=1`）。用途、创建时间、明文格式/版本/大小/SHA-256、KDF 参数、salt、cipher 和 IV 会作为 GCM additional data 认证。公开 CLI 结果会报告算法和明文元数据，但省略 salt、IV、tag、ciphertext 和 passphrase。

Import 和 restore 会自动检测加密 envelope。存在 `REPOMIND_ARCHIVE_PASSPHRASE` 时读取该变量，否则读取 `--passphrase-env` 指定的变量：

```powershell
repomind import --input D:\backups\repository.enc.json --dry-run --json
repomind import --input D:\backups\repository.enc.json --yes --json
repomind restore --input D:\backups\repomind.db.enc --dry-run --json
repomind restore --input D:\backups\repomind.db.enc --yes --json
```

Passphrase 错误、ciphertext 或 tag 变化、已认证元数据变化、归档用途不匹配，都会在写入逻辑目标数据或 live database 前失败。加密物理备份是单个 JSON 文件，没有 sidecar manifest；已认证 envelope 携带大小和哈希。Restore 会短暂地在操作系统临时目录中暂存解密后的 SQLite，在支持 POSIX mode 的平台上请求 0600 文件模式，并在成功或失败后的 `finally` 中删除该目录。

加密保护静态的可移植归档。它不加密 RepoMind 的 live local database，也不加密同一数据目录中 restore 前的 rollback snapshot；不隐藏 envelope 大小和创建元数据；不提供 key escrow、rotation、定时备份或云存储。请保护环境和宿主进程，并将 passphrase 与归档分开保存。

## 逻辑导入

```powershell
repomind import --input D:\backups\repository.json --dry-run --json
repomind import --input D:\backups\repository.json --yes --json
```

逻辑导入只有一种明确模式：`replace`。Dry-run 会验证 envelope、checksum、表契约、敏感模式、schema 兼容性和 active-work guard，不修改数据。`--yes` 在一个 SQLite 事务中删除当前仓库的逻辑数据并插入归档。Constraint error 会回滚整个事务。

结果保留来源 Project ID 作为 provenance，同时将所有 repository 和 checkout 外键映射到已初始化目标。这样，已审查导出可以为另一个仓库提供种子，而无需改写其 `.repomind/project.json`。Memory、Evidence、Session、L2、L3 和 L4 Candidate ID 保持稳定。FTS 在同一事务中重建，向量恢复为空的可重建状态。

Merge import 有意不实现。合并两份受治理的 Memory 历史需要 duplicate、contradiction、Audit 和 ID collision 策略；静默地把 replacement 当成 merge 会使恢复行为不可预测。

## 物理备份

```powershell
repomind backup --output D:\backups\repomind.db --json
```

Backup 使用 SQLite `VACUUM INTO` 生成一致的独立数据库，同时写入 `repomind.db.manifest.json`，其中包含格式版本 1、Project ID、schema 版本、字节长度和 SHA-256。两个文件都不能已存在。命令拒绝为 open Session 或 running Host Run 创建 snapshot。

请将数据库和 manifest 一起保存。修改任一文件都会使 restore 失败。

## 物理恢复

```powershell
repomind restore --input D:\backups\repomind.db --dry-run --json
repomind restore --input D:\backups\repomind.db --yes --json
```

Restore 要求备份 Project ID 与仓库 marker Project ID 相同。不同 Project ID 应使用逻辑导入。Dry-run 会验证 manifest、checksum、SQLite integrity、schema、仓库身份和 active work 状态。

确认 restore 后，系统在 live database 旁暂存并迁移一个副本。替换前，RepoMind 创建带 checksum 的 `repomind.db.pre-restore-<id>.db` snapshot 和 manifest，然后将暂存数据库替换进去，并通过正常迁移路径打开。若验证失败，被替换的 live database 及其 WAL 状态会自动恢复。

若 live database 本身无法打开，restore 不会猜测原因是损坏、锁还是其他存储故障。诊断问题后，使用 `--allow-unreadable` 显式授权替换。交换前，RepoMind 会把不可读文件复制为 `.pre-restore-<id>.unreadable.db` 制品。live database 缺失时无需该 flag 即可恢复。

## 当前边界

当前迭代提供本地 CLI 恢复和可选加密归档，不提供定时备份、云同步、MCP restore 工具、key-management service 集成或逻辑 merge。现有明文 export 版本 1/2 和 backup 格式 1 仍保持兼容。
