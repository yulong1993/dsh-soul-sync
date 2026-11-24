# dsh-soul-sync — DeepSeek Harness 跨电脑防灾备份与「不断魂」接力套件

> **一句话讲清楚**：你在公司 Windows 电脑上让 DeepSeek Harness 跑了一下午的财报拆解、Python 估值脚本和 Excel 模型，下班合上盖子回家打开 Mac，对话记录、推理心路、脚本和表格全部自动到位——AI 不会像失忆了一样把你刚才干的活说成“据前文所述”，而是顺着刚才的思路以第一人称直接往下接；就算哪天电脑突然断电或主板烧毁，换台新电脑 3 步就能满血复活。

---

## 1. 这是什么 & 核心安全承诺

传统的做法是把整个项目文件夹直接扔进 OneDrive / iCloud，但只要用过就知道坑有多深：Excel 开着就报冲突副本、Git 仓库 `.git` 经常被网盘同步坏、几十 GB 原始数据瞬间塞爆云盘。

`dsh-soul-sync` 采用**「本地工作、金库中转」**设计，给你四条铁律级的安全承诺：

1. **本地工作文件夹绝不放进网盘**：你的项目继续安心放在 `D:\美股分析` 或 `/Users/你/美股分析`，网盘里只放一个专门的加密防灾金库目录（例如 `OneDrive\dsh-vault`）。
2. **不怕 Excel 锁死、不怕 Git 损坏**：
   - 自动忽略 `.git/`、`node_modules/`、虚拟环境、超大原始库与未写完的半截表格；
   - 如果对方电脑推来新版 `.xlsx` 时你正好开着 Excel，它绝不会硬撞报错，而是先安全暂存到 `.dsh-incoming/`，等你关掉 Excel 后一键落位。
3. **可选端到端 AES-256-GCM 加密**：首次安装时设一个口令，所有写进网盘的对话和表格在离开本机前都会加密成密文（网盘和云服务商完全看不见内容），且**派生密钥只保存在本机 `~/.dsh/soul-sync/secret.key`，绝不上传金库**。
4. **绝对不碰 API 密钥**：全程物理跳过 `~/.dsh/.credentials.yaml` 与项目里的 `.env` / 含 `sk-` 密钥的脚本，宁可拦截报错也绝不把任何密码或 API Key 写进网盘。

---

## 2. 两分钟首次配置

### 第一步：选一个网盘金库目录

在你的 OneDrive、iCloud Drive、百度网盘同步盘或 NAS 映射盘里，新建一个空文件夹专门当**防灾金库**，例如：
- Windows：`D:\OneDrive\dsh-vault`
- macOS：`/Users/你的用户名/Library/CloudStorage/OneDrive-Personal/dsh-vault`

> 小贴士：建议右键这个金库文件夹，勾选 **「始终保留在此设备上 / Always keep on this device」**，避免网盘自动清理缓存导致换机时还要等下载。

### 第二步：在 Windows 上一键安装

先右键退出右下角托盘里的 **DeepSeek Harness**，然后在 PowerShell 里运行（把路径和口令换成你自己的）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-win.ps1 `
  -VaultDir "D:\OneDrive\dsh-vault" `
  -Passphrase "你的专属同步口令" `
  -Map "us-equity=D:\美股分析::/Users/你的Mac用户名/美股分析"
```

- 如果不想每次敲参数，也可以直接运行 `powershell -ExecutionPolicy Bypass -File .\scripts\install-win.ps1`，会进入中文问答向导一步步带你填。
- 如果有多个常用项目，可以重复传多个 `-Map`（例如 `-Map "D:\美股分析::/Users/me/美股分析","D:\A股跟踪::/Users/me/A股跟踪"`）。
- 如果只用内部信任网盘、不想设加密口令，把 `-Passphrase "..."` 换成 `-NoPassphrase` 即可。

### 第三步：在 macOS 上一键安装

先把 `dsh-soul-sync` 文件夹拷贝到 Mac，彻底退出 DeepSeek Harness（`Cmd+Q`），打开「终端」运行：

```bash
bash ./scripts/install-mac.sh \
  --vault "/Users/你的Mac用户名/Library/CloudStorage/OneDrive-Personal/dsh-vault" \
  --passphrase "你的专属同步口令" \
  --map "us-equity=D:\美股分析::/Users/你的Mac用户名/美股分析"
```

> **双端必须保持一致的两件事**：① 同一个加密口令（或都不设口令）；② 相同的 `--map` 映射规则（`Windows路径::Mac路径`）。

安装脚本会自动帮你完成：
- 生成 `~/.dsh/soul-sync/config.json` 与本机密钥；
- 写入全局跨平台规则 `~/.dsh/AGENTS.md`（让 AI 写 Python 脚本自动兼容 Windows/Mac 路径与中文字体）；
- 安装接力技能 `~/.dsh/skills/soul-handoff/SKILL.md`；
- 自动把插件注册到 `web` 和 `desktop` 两个配置里，并跑一遍 `doctor` 体检。

重新打开 DeepSeek Harness，在任意对话框输入 `/soul status`，看到 **《双机接力体检卡》** 就成功了！

---

## 3. 日常怎么用

### 零感知自动防灾（平时什么都不用做）

- **每 30 秒自动防灾快照**：就算 AI 正在跑一个长达 10 分钟的多步分析，每完成一步（按 30 秒节流）都会把最新对话进度默默存进金库，突然断电最多只丢最后不到半分钟。
- **每轮对话结束自动双平面同步**：聊完一轮，对话记录、附图附件、以及这轮 AI 写出的 Python 脚本 / Excel 表格 / Markdown 报告会自动同步到金库。
- **打开电脑自动拉取**：另一台电脑启动 DeepSeek Harness 时，会自动静默把远端最新对话和表格拉到位，并自动把目录从 `D:\美股分析` 翻译成 `/Users/你/美股分析`。

### 下班换电脑前的 10 秒仪式：`/soul handoff`

准备合盖换另一台电脑继续干活前，在当前对话里发一句：

```text
/soul handoff 晚上回家用 Mac 继续做毛利率敏感性测算
```

它会立刻做三件事：
1. **检查有没有忘记关 Excel**：如果检测到 `~$估值表.xlsx` 占锁，立刻提醒你先 `Ctrl+S` 保存并关掉 Excel；
2. **让 AI 写一段 150~250 字的第一人称《中场交接心路日记》**：把我们正在推进的核心命题、刚才试过走不通的死胡同（伤疤清单）、以及下一步动作直接留在对话里；
3. **Flash 看图 → V4Pro 深度推演无缝桥接**：如果你在公司用支持看图的 `deepseek-flash` 看过财报截图/K 线图，回家切到纯文本的 `deepseek-v4-pro` 深度推理，交接日记和自动压缩都会把图里的核心数字、拐点和结论转写成清晰文字，绝不会换了模型就“失明”。

等你回家打开 Mac 点开同一个会话接着聊，插件会自动给 AI 递上一句第一人称接力备注，AI 开口就是顺着刚才的上下文自然往下推进，完全没有“换了个陌生助手”的割裂感。

---

## 4. Python 脚本、Excel 表格与报告怎么同步

为了既不错过任何劳动成果，又绝不把几十 GB 原始历史库拖进网盘，本套件按**「来源账本」**精准同步：

| 文件类型 | 是否自动同步 | 说明 |
| --- | :---: | --- |
| `outputs/` 目录下的所有报告、图表、估值表 | 自动同步 | 推荐约定：最终成果一律放 `outputs/` |
| AI 动手创建或修改过的 `.py` / `.xlsx` / `.md` 等 | 自动同步 | 只要纳入账本，后续你手工在 Excel 里改的数字也会持续跟着同步 |
| `.work/` 目录里的临时草稿与缓存 | 自动忽略 | 脏数据和中间过程不污染同步 |
| 已纳入 Git 管理的源码文件（`git ls-files`） | 自动忽略 | 交给 Git 管，绝不跟网盘打架 |
| 原本就在目录里的存量历史大文件 | 自动忽略 | 不会把几十 GB 老资料搬进金库 |
| `.env`、含 `sk-` 密钥文件、破损半截 `.xlsx`/`.pdf` | 自动拦截 | 保护隐私并防止半成品覆盖好版本 |

### 几个超实用的日常技巧

- **手工建的文件也想同步**：比如你自己新建了一个 `notes/核心假设.md` 或手工做了一张 `草稿估值.xlsx`，直接发：
  ```text
  /soul keep notes/核心假设.md
  ```
  就会立刻记入账本并同步到另一台电脑。
- **Excel 没关导致占锁怎么办**：不用慌！远端推来的新版表格会自动暂存在工作区里的 `.dsh-incoming/` 目录。你关掉 Excel 后，发一句 `/soul pull`（或在终端运行 `dsh-soul pull`），它就会自动落位并清空 `.dsh-incoming/`。
- **两台电脑离线同时改了同一张表怎么办**：绝不互相覆盖！本机版本原样保留，另一台电脑的版本会并列保存成 `估值表 (来自家里Mac 2026-11-24).xlsx`，让你对照合并。
- **误删文件能找回吗**：对端删除文件时，本机不会直接永久粉碎，而是先移到 `~/.dsh/trash/<工作区>/` 保留 **14 天**，随时可捡回来。

---

## 5. 电脑突然断电 / 主板烧毁急救指南

如果公司电脑彻底报废，换一台全新电脑（无论 Windows 还是 Mac），只需要 **3 步** 满血复活：

1. **安装网盘客户端并等防灾金库同步完成**（确保金库目录里的 `blobs/` 和 `devices/` 已下载到本地）。
2. **安装 DeepSeek Harness 并跑一遍一键安装脚本**，填入同样的金库路径、同样的加密口令和新电脑的工作区路径映射：
   ```powershell
   # Windows 新电脑示例
   powershell -ExecutionPolicy Bypass -File .\scripts\install-win.ps1 `
     -VaultDir "D:\OneDrive\dsh-vault" `
     -Passphrase "你之前设的口令" `
     -Map "us-equity=D:\美股分析::/Users/你/美股分析"
   ```
3. **执行离线全量恢复**（如果还没开 DSH，直接终端运行一行即可）：
   ```powershell
   node .\bin\dsh-soul.js pull
   ```
   全部历史会话、子代理推演、附图附件、全局 `AGENTS.md` 规则以及各工作区里的 Python 脚本、Excel 估值表和报告都会自动还原到位！

---

## 6. 配额调整与命令速查表

默认安全配额：单文件上限 **30 MB**、单工作区上限 **500 MB**、历史版本保留 **10 份**、步级防灾节流 **30 秒**、软删除回收站保留 **14 天**。你可以随时动态修改，不用重启。

### A. DeepSeek Harness 对话框内斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/soul status` | 查看《双机接力体检卡》（金库、加密状态、双端心跳、Flash/V4Pro 档位提示、Excel 占锁与 `.dsh-incoming/` 状态） |
| `/soul handoff [备注]` | 下班换机仪式：检查 Excel 锁、生成第一人称交接日记、备份并释放接力棒 |
| `/soul pull` | 立即从金库拉取最新会话与产出物，并自动排空 `.dsh-incoming/` 暂存文件 |
| `/soul push` | 立即把当前会话与工作区受管产出物推送到金库 |
| `/soul keep <相对路径>` | 手动把某个本地文件纳入同步账本并立即推送 |
| `/soul config` | 查看当前配额与配置 |
| `/soul config maxFileMB=64 retainSnapshots=15` | 实时调整单文件上限、工作区上限、历史保留份数等配额 |

### B. 独立命令行工具（`node ./bin/dsh-soul.js` 或 `dsh-soul`）

| 命令 | 作用 |
| --- | --- |
| `dsh-soul init [选项]` | 交互式或参数化初始化配置、金库、加密口令、工作区映射与技能 |
| `dsh-soul status` | 查看完整双机同步与本地会话/工作区统计报告 |
| `dsh-soul push [--workspace <目录>]` | 离线全量备份本机全部会话、`AGENTS.md` 与所有映射工作区产出物 |
| `dsh-soul pull [--force]` | 离线全量恢复/合并（若检测到桌面端正在运行会温和保护，可传 `--force` 强制） |
| `dsh-soul keep <路径> [--workspace <目录>]` | 手动纳管指定文件并立即推送 |
| `dsh-soul config [key=value ...]` | 查看或修改 `maxFileMB`、`maxWorkspaceMB`、`retainSnapshots`、`stepSyncIntervalMs`、`trashRetentionDays`、`deviceLabel`、`vaultDir` |
| `dsh-soul doctor` | 全面自检配置、金库可读写性、加密密钥、技能、规则块与 DSH 插件注册状态 |
| `dsh-soul watch [--interval-ms 60000]` | 启动轻量级后台守护进程，定时备份会话与监听工作区产出物变更 |
