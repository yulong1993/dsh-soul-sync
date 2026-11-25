# `dsh-soul-sync` 设计规格书：跨系统（Win ⇄ Mac）防灾与“亲历感”无损接力套件

## 核心目标与已锁定产品决策

1. **硬核防灾（Disaster Recovery）**：本地工作文件夹 100% 留在各自电脑硬盘（不放入网盘），网盘仅存放 `dsh-vault/` 金库。任一电脑突发损坏，另一台电脑最多损失最近 ~30 秒对话，且模型产出的 Python 脚本、Excel 表格、报告与聊天附件完整可恢复。
2. **消除“看传记感”（First-Person Continuity）**：根治跨端导入后模型像“旁观者看别人传记”的割裂感，让模型在双端均以**第一人称亲历视角**无缝延续记忆、思辨张力、试错伤疤与交互默契。
3. **五项用户拍板决策（Locked Decisions）**：
   - **Q1 双入口覆盖**：安装向导默认同时装入 `desktop` 与 `web` 两个 DSH Profile；若检测到 Desktop 进程在线则温和提示先退出托盘。
   - **Q2 DeepSeek `Flash` ⇄ `V4Pro` 深度协同与多模型兼容**：
     - `@deepseek-ai/dsh-llm-deepseek` 中 `deepseek-flash` 支持图文输入与 `in-history` 更新，而 `deepseek-v4-pro` 仅支持纯文本（历史图片降级为稳定占位符）。
     - 保留各会话自身记录的模型路由与 `reasoningEffort`；`/soul` 体检卡对双端默认模型差异做温和提示而不阻断（完美支持“Flash 读图跑脚本 + V4Pro 深度推演”双档配合）；在 `dsh-compaction-soul` 与 `/soul handoff` 中内置**视觉文字桥接规则**，强制把图片/截图中的关键数值与结论文字化，切到纯文本 `V4Pro` 绝不丢失图表信息；同时兼容 `llm-pi-ai` 其他模型路由。
   - **Q3 透明端到端加密**：内置可选 `scrypt` + `AES-256-GCM` 认证加密（口令派生的密钥仅存本机 `~/.dsh/soul-sync/secret.key`，永不进网盘），安装时填口令即开启密文金库，回车留空则为明文模式。
   - **Q4 无冲突全自动静默落盘**：启动或切换设备时，单边无冲突更新的会话与产出文件后台自动快进到位（仅状态提示）；仅当发生双边离线同改冲突、会话脑裂分叉或本地 Excel 占锁时才提醒。
   - **Q5 可调防爆仓配额**：默认单产出文件 `≤ 30 MB`、单项目金库 `≤ 500 MB`、每会话/每产出路径保留最近 `10` 个历史版本，所有阈值均可在 `~/.dsh/soul-sync/config.json` 中自由修改。

## 架构分层

1. **中立防灾金库（`lib/crypto-vault.js`）**：分设备独立写入目录 `devices/<deviceId>/` + 内容寻址 `blobs/sha256/<2hex>/<hash>` + Manifest-Last 原子提交 + 全量字节与 SHA-256 完整性校验（防 OneDrive 按需未下载 / `.icloud` 空壳） + 可选 AES-256-GCM 透明加解密 + 版本保留 GC。
2. **Zstd V4 帧编解码与路径规范层（`lib/zstd-v4.js`、`lib/config.js`）**：严格匹配 `dsh-session-persistence-jsonl` 的多帧带校验和（`ZSTD_c_checksumFlag: 1`）格式（第 0 帧独立 Header 帧）、`scanZstdFrames` 撕裂尾帧恢复、`encodeSegment` / `projectKey`、以及 `fs.realpath` + NFC 跨平台路径映射。
3. **叙事平面（`lib/session-plane.js`）**：
   - 根会话 + Subagent 子会话血缘闭包 + `$DSH_HOME/attachments/v1/` 内容寻址附件打包与重建；
   - 精确最小路径重写（仅改 `HeaderLine.cwd`、`working-directory/change.data.cwd`、`deliverables/presented` 文件路径，严禁触碰消息体/流/思考签名）；
   - 快进合并与零 `seq` 偏移脑裂分叉（克隆新 `branchId` 并同步修正 `seq >= inheritedEventCount` 的 `session-log-deepseek/delivery-accepted.data.sessionId` 与子会话 `parentSession`）；
   - 运行态通过 `ctx.sessionPersistence` / `ctx.workspaceRegistry` / `ctx.storageDomain` 免重启更新，离线态校验无锁后安全更新 `storages/workspace.json` v2 并清理 `session_projcache`。
4. **抗失忆压缩与多次压缩防衰减层（`lib/compaction-soul.js` + `lib/tail-compactor.js` + `lib/recall-tool.js`）**：
   - 通过 `llm/stream` 瀑布流拦截（兼容 DSH Preset 隔离墙且 100% 保持 `options.messages.slice(0, -1)` 对象引用以命中 DeepSeek Prefix Cache）升级全部自动压缩与 `/compact` 指令为内嵌两段式防衰减结构（跨代锁定钢印共识 ≤ 600 字 / 显式翻案才可改 + 滑动金字塔里程碑 + 高危伤疤 ≤ 10 条 + `Flash → V4Pro` 视觉文字桥接 + 思维链/纠偏复盘），并内置流式输出体积收敛护栏同步修正 `text-delta` 与 `block-end.block.text`，确保恒满足 `framedSummaryTokenCount < shadowedRouteTokenCount`；
   - 提供宿主侧保尾不断魂无损压缩器（`lib/tail-compactor.js`，支持 `/soul compact [保留轮数]` 与中文自然语言触发），在 `agent.runMaintenance` 锁内保留末尾 K 轮完整人类对话（含原生 `reasoning` 思维链与平衡的 `tool-call`/`tool/result` 配对），以标准 V4 四事件（省略 `sourceCommandId`）原子落盘并同步加密金库；
   - 静态注册只读并发安全历史底稿回捞工具 `soul_recall_history`（`lib/recall-tool.js`），直接内存检索已被压缩折叠或剪枝隐藏的原始事件、思维链与原始工具输出；
   - 叙事平面内置 `hasUnclosedCompaction` 护栏，自动跳过未闭合 `compaction/start` 瞬间的快照导出，杜绝跨机拉到半截锁状态。
5. **产出平面（`lib/deliverable-plane.js` + `lib/artifact-worker.js`）**：
   - 四信号定向纳管（写文件工具、`deliverables/presented`、活跃会话期目录写事件、`outputs/**` + `/soul keep`），排除 `git ls-files` 与历史存量只读文件；
   - Worker 线程执行 1.5s 静默稳定守卫 + 容器尾标验尸闸（`.xlsx`/`.docx`/`.pptx` EOCD `PK\x05\x06`、`.pdf` `%%EOF`、`.png` `IEND`、`.parquet` `PAR1`）+ 双层密钥/Symlink/硬链接拦截 + Windows 文件名合法性净化；
   - 工作区级三路合并（`baseTree`）：无冲突静默快进、双边修改留存冲突副本、`EBUSY`/`~$*.xlsx` 锁暂存 `.dsh-incoming/`、远端删除移入 `~/.dsh/trash/` 保留 14 天。
6. **Cordis 宿主插件、Skill 与跨端安装器（`lib/index.js`、`skills/soul-handoff/SKILL.md`、`bin/dsh-soul.js`、`scripts/install-win.ps1`、`scripts/install-mac.sh`）**：挂载生命周期钩子、跨 OS 首次续聊注入第一人称《跨设备接力备注》、注册 `/soul` 斜杠命令、同步全局 `AGENTS.md` 五条跨平台 Python/Excel 规则，并提供一键交互式安装向导与同事使用手册。
