# 一段提示词让 DeepSeek Harness 全自动帮你安装 `dsh-soul-sync`（零命令行）

> **给非技术同事的使用说明**：你完全不用打开黑框命令行，也不用记目录配对参数！
> 只要打开 **DeepSeek Harness**，新建一个对话，**复制下面整个灰色代码块里的文字发送给 AI**，只需回答 **2 个大白话小问题**（网盘金库路径 + 可选加密口令），AI 就会自动替你把插件装好并体检通过。装好重启后，平时**完全不用敲任何命令**（也可以随时在 DSH 左下角 **「设置 → Soul Sync 跨机迁移」** 图形界面里改配置、绑定目录或勾选迁移）。

---

## 请复制下面整段提示词发给 DeepSeek Harness

```text
请你帮我安装并配置 DeepSeek Harness 跨电脑防灾同步与灵魂接力插件（dsh-soul-sync）。
我是非技术用户，不需要我敲命令行，请你全程替我执行并只用通俗易懂的中文和我沟通。请严格按以下 4 步推进：

### 第 1 步：准备或更新本机 `dsh-soul-sync` 插件目录（无需我装 Git）
- 先检查当前工作区或固定目录（Windows 优先看 `$HOME\Documents\dsh-soul-sync`；macOS 优先看 `~/Documents/dsh-soul-sync` 或 `~/Documents/deepseek-harness/dsh-soul-sync`）是否已有 `dsh-soul-sync`（含 `scripts/install-win.ps1`、`scripts/install-mac.sh` 与 `bin/dsh-soul.js`）。
- 如果本机还没有：无需让我手动下载，请直接替我从公开仓库 `https://github.com/yulong1993/dsh-soul-sync` 自动拉取到我的「文档」固定目录（有 `git` 可 `git clone https://github.com/yulong1993/dsh-soul-sync.git`；没装 `git` 可直接用系统自带的下载命令——Windows 用 `curl.exe -L`，macOS 用 `curl -L`——下载 `https://codeload.github.com/yulong1993/dsh-soul-sync/tar.gz/refs/heads/main` 配合 `tar -xzf` 解压成 `dsh-soul-sync` 文件夹），并提醒我日后不要删除该文件夹。
- 如果本机已经有了且含 `.git` 目录，请顺手先 `git pull` 更新到最新版。

### 第 2 步：用大白话一次性向我确认 2 个核心问题（不要分开追问太多轮）
1. **网盘里的「防灾金库」文件夹路径**：问我准备用哪个网盘同步目录当金库（例如坚果云 / OneDrive / iCloud 下的空文件夹 `dsh-vault`，提醒我右键该网盘文件夹勾选「始终保留在此设备上 / Always keep on this device」）。如果目录还没建好，主动告诉我你可以顺手帮我建出来。
2. **是否设置端到端加密口令**：说明设一个口令后，写进网盘的对话和产出文件会自动加密，两台电脑填同一个口令即可；如果我不想把口令发在聊天记录里，也可以告诉我「先跳过加密，装好重启后我自己去左下角『设置 → Soul Sync 跨机迁移』密码框里填写」（非常推荐）。
（补充说明：不需要强制问我工作目录映射——未配映射时插件会自动创建独立同名工作区并随身同步 `outputs/` 产出 ≤30MB；如果我本机旧对话很多、希望先由我自己勾选再推送，再问我是否开启精选模式并传 `-Scope selected` / `--scope selected`；只有当我主动提到固定项目目录配对时才传 `-Map` / `--map`。）

### 第 3 步：识别当前系统并自动执行一键安装脚本
拿到我的回答后，先在需要时帮我创建空的金库目录，然后根据当前操作系统直接替我运行非交互安装命令（注意给所有含空格或中文的路径加引号）：

- **如果当前是 Windows**：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\install-win.ps1" `
    -NonInteractive `
    -VaultDir "<金库路径>" `
    -Passphrase "<加密口令>"
  ```
  - 可选参数替换说明：若跳过加密（或准备重启后在图形面板密码框里再填），把 `-Passphrase "<加密口令>"` 改为 `-NoPassphrase`；若要求首启仅手动勾选同步，追加 `-Scope selected`；若主动要求关闭 30 秒快照，追加 `-DisableStepSync`。

- **如果当前是 macOS**：
  ```bash
  bash "<repo>/scripts/install-mac.sh" \
    --non-interactive \
    --vault "<金库路径>" \
    --passphrase "<加密口令>"
  ```
  - 可选参数替换说明：若跳过加密（或准备重启后在图形面板密码框里再填），把 `--passphrase "<加密口令>"` 改为 `--no-passphrase`；若要求首启仅手动勾选同步，追加 `--scope selected`；若主动要求关闭 30 秒快照，追加 `--disable-step-sync`。

### 第 4 步：核对体检结果并教我怎么用
- 检查安装输出里最后的 `dsh-soul doctor` 是否显示 **「体检通过：全部核心组件运行健康！」**（`doctor` 会自动校验本机口令能否解密金库中已有记录；若提示 `vault-decrypt` 失败，说明与另一台电脑口令不一致，请帮我核对并重设口令直到体检通过，不要把原始英文堆栈甩给我）。
- 全部通过后，用简洁明了的中文告诉我：
  1. **现在只需重启一次 DeepSeek Harness**（Windows 右键右下角托盘彻底退出再打开；Mac 按 `Cmd+Q` 退出再打开），插件就会立刻生效；
  2. **平时使用完全是零命令全自动的**：在一台电脑聊完合盖走人，另一台电脑打开软件（或运行中每 15 秒自动检测网盘更新），左侧对话列表第一条就会自动出现刚才的原装对话，直接点开接着聊即可；
  3. 如需改路径、口令、绑定目录对应、勾选按需迁移或开关 30 秒防断电快照，可直接在 **DSH 左下角「设置 → Soul Sync 跨机迁移」** 图形界面修改，或偶尔发：
     - `/soul 帮我看看现在同步正常吗`（秒看双机体检卡）
     - `/soul 帮我无损压缩一下`（长对话无损瘦身：置顶钢印不丢 + 保留最后 3 轮原装思维链，早期细节 AI 自动翻底稿）
     - `/soul 同步一下`（立即双向同步最新进度）
```

---

## 另一台电脑或同事怎么装 / 怎么升级？

- **首次安装（连压缩包都不用拷）**：在另一台电脑打开 DeepSeek Harness，直接把上面**同一段提示词**发给 AI，AI 会自动从公开仓库下载好插件，你只需填入**同一个网盘金库文件夹**和**同一个加密口令**即可！
- **日后升级**：直接打开左下角 **⚙️「设置 → Soul Sync 跨机迁移」**，点击右上角 **「⬆️ 检查更新」 → 「立即一键更新」**（不管电脑装没装 Git 都能秒更），重开一次软件即生效！
