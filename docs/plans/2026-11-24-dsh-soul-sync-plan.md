# dsh-soul-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete, zero-native-compilation `dsh-soul-sync` plugin bundle, standalone disaster-recovery CLI, first-person native-language compaction engine, provenance-proven deliverable sync engine, cross-OS installers, and automated test suite for DeepSeek Harness (`dsh`).

**Architecture:** Dual-plane architecture separating append-only V4 Session Lineage Closure (`session-plane`) from stateful 3-way merged Workspace Deliverables (`deliverable-plane`), exchanging immutable SHA-256 verified (and optionally AES-256-GCM encrypted) blobs over a device-sharded cloud-drive vault (`crypto-vault`). Ships as pre-built pure ESM JavaScript using Node 22.15+/24 built-in `node:zlib` Zstandard, `node:crypto`, and `node:worker_threads` so DSH Desktop/Web installs it in <500ms without C++ build tools.

**Tech Stack:** Node.js ≥ 22.15 / 24 ESM (`node:zlib` Zstd, `node:crypto` AES-256-GCM + scrypt, `node:worker_threads`, `node:test`), DeepSeek Harness (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-compaction-basic`), PowerShell 5.1+ (`install-win.ps1`), POSIX Bash (`install-mac.sh`).

---

## File Map

- `package.json` — DSH bundle manifest (`dsh.bundle.patch`, `engines.dsh: ">=0.1.0-0"`, `bin.dsh-soul`, UTF-8 no BOM)
- `cordis.patch.yml` — Host-plane Cordis insert entry for `dsh-soul-sync`
- `locale/zh.json` & `locale/en.json` — Localized plugin title & description for DSH UI
- `lib/config.js` — Config schema, customizable quotas (`30MB` file / `500MB` workspace / `10` snapshots / `30s` step RPO), device identity, bidirectional Win⇄Mac workspace path mapper (`realpath` + NFC), and global `AGENTS.md` cross-platform rule templates
- `lib/crypto-vault.js` — Device-sharded Manifest-Last vault, optional `scrypt` + `AES-256-GCM` authenticated encryption, `.icloud` / unhydrated placeholder guard, SHA-256 closure verifier, baton heartbeat, and retention GC
- `lib/zstd-v4.js` — Exact DSH V4 checksummed multi-frame Zstd encoder/decoder (`ZSTD_c_checksumFlag: 1`, Frame 0 header invariant), `scanZstdFrames` + `ZSTD_e_flush` torn-tail recovery, `encodeSegment`, and `projectKey`
- `lib/session-plane.js` — Root + Subagent lineage closure export/import, `$DSH_HOME/attachments/v1/` blob pack/restore, minimal path mapper (`HeaderLine.cwd`, `working-directory/change.data.cwd`, `deliverables/presented`), fast-forward & zero-shift split-brain fork (`delivery-accepted` `sessionId` rewrite), live Cordis vs offline `workspace.json` v2 + `session_projcache` reconciler
- `lib/artifact-worker.js` — Worker thread performing 1.5s file stability check, container trailer verification (`.xlsx`/`.docx`/`.pptx` EOCD, `.pdf` `%%EOF`, `.png` `IEND`, `.parquet` `PAR1`), 2-layer secret/credential scan, symlink/junction/`nlink > 1` guard, and Windows filename legality check
- `lib/deliverable-plane.js` — 4-signal provenance ledger (`trackedSet`, `git ls-files` exclusion, `outputs/**`, `/soul keep`), Worker pool dispatcher, and 3-way merge engine (`baseTree`, conflict copies, `.dsh-incoming/` Excel lock staging, 14-day `~/.dsh/trash/` soft-delete)
- `lib/compaction-soul.js` — `SoulCompactionEngine` subclassing `BasicCompactionEngine.summarize()` (first-person native-language prompt + 6 cognitive anchors + `Flash → V4Pro` visual-to-text bridge + `retainRatio: 0.25`) + profile preset patch helper
- `lib/index.js` — Main Cordis Host plugin: lifecycle hooks (`step/end` 30s RPO, `turn/end`, `session/disposed`, `job/settled`, `tools/result`, `agent/pre-step` cross-OS migration note + `Flash ⇄ V4Pro` check), startup auto-pull, and `/soul` slash command (`status`, `handoff`, `pull`, `push`, `keep`, `config`)
- `skills/soul-handoff/SKILL.md` — Companion DSH Skill for first-person handoff diary, visual-to-text bridge, and multi-session synthesis workflow
- `bin/dsh-soul.js` — Standalone CLI (`init`, `status`, `push`, `pull`, `keep`, `doctor`, `watch`) for setup, background daemon, and offline disaster recovery
- `scripts/install-win.ps1` & `scripts/install-mac.sh` — One-click cross-OS installers (bypassing `dsh.cmd` `&` path bug, detecting running Desktop app, installing into `desktop` + `web` profiles)
- `README.md` — Colleague-friendly Chinese setup, daily operation, and disaster-recovery handbook
- `tests/vault-and-zstd.test.js` — Unit & edge-case tests for Zstd V4 framing, torn-tail recovery, `projectKey`, AES-256-GCM encryption, and Manifest-Last verification
- `tests/session-plane.test.js` — Tests for Win⇄Mac minimal path rewriting, V4 invariants, subagent + attachment closure, fast-forward, and zero-shift split-brain fork
- `tests/deliverable-plane.test.js` — Tests for provenance ledger, torn `.xlsx` EOCD rejection, `.env`/secret/symlink blocking, Excel `~$` lock `.dsh-incoming/` staging, 3-way merge conflict copies, and 14-day trash soft-delete
- `tests/dsh-integration.test.js` — End-to-end integration test mounting `dsh-soul-sync` into the real local DSH `0.2.2-rc.1` CLI sandbox and verifying Win→Mac→Win roundtrip

---

### Task 1: Package Scaffold, Config, Path Mapper & Vault Crypto Core

**Files:**
- Create: `d:\AI&Agent_learning\dsh-soul-sync\package.json`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\cordis.patch.yml`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\locale\zh.json`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\locale\en.json`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\config.js`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\crypto-vault.js`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\zstd-v4.js`
- Test: `d:\AI&Agent_learning\dsh-soul-sync\tests\vault-and-zstd.test.js`

- [ ] **Step 1: Write failing tests for Zstd V4 multi-frame codec, torn-tail recovery, `projectKey`, path mapping, and AES-256-GCM Manifest-Last vault**
  Create `tests/vault-and-zstd.test.js` asserting:
  1. `encodeV4Frames(headerObj, events)` produces Frame 0 containing ONLY `JSON.stringify(headerObj) + "\n"` with Zstd checksum flag enabled (`(descriptor & 4) !== 0`), and `decodeV4Frames` roundtrips identically.
  2. Appending truncated Zstd bytes at EOF recovers all prior frames and complete JSONL lines via `ZSTD_e_flush` without throwing.
  3. `projectKey("D:\\文章")` produces `"--D-~6587~7AE0--"` matching DSH's exact UTF-16 code-unit encoding, and `mapPathAcrossOs` maps `"D:\\美股分析\\scripts\\dcf.py"` ⇄ `"/Users/colleague/美股分析/scripts/dcf.py"` with NFC normalization.
  4. `VaultStore` with passphrase encrypts blobs & commits with AES-256-GCM (ciphertext on disk contains zero plaintext substrings), rejects `.icloud` / truncated blobs during `verifyCommitClosure`, and retains last `retainSnapshots` commits on GC.
- [ ] **Step 2: Run test to verify failure**
  Run: `Push-Location "d:\AI&Agent_learning\dsh-soul-sync"; node --test tests/vault-and-zstd.test.js; Pop-Location`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).
- [ ] **Step 3: Implement `package.json`, `cordis.patch.yml`, `locale/*.json`, `lib/config.js`, `lib/crypto-vault.js`, and `lib/zstd-v4.js`**
  Ensure all files are written as UTF-8 without BOM, using atomic temp-file + rename writes with Windows `EACCES`/`EBUSY`/`EPERM` bounded retry.
- [ ] **Step 4: Run test to verify pass**
  Run: `Push-Location "d:\AI&Agent_learning\dsh-soul-sync"; node --test tests/vault-and-zstd.test.js; Pop-Location`
  Expected: PASS (all assertions green).

---

### Task 2: Narrative Plane — V4 Session Lineage Closure, Minimal Path Rewrite & Zero-Shift Split-Brain Fork

**Files:**
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\session-plane.js`
- Test: `d:\AI&Agent_learning\dsh-soul-sync\tests\session-plane.test.js`

- [ ] **Step 1: Write failing tests for session closure export/import, attachment reconstruction, minimal path rewrite, and split-brain fork**
  Create `tests/session-plane.test.js` asserting:
  1. Exporting a Windows root session with a subagent child session and `$DSH_HOME/attachments/v1/` image + named file packs the entire closure into the vault.
  2. Importing onto simulated macOS rewrites `HeaderLine.cwd`, `working-directory/change.data.cwd`, and `deliverables/presented` paths while keeping `assistant/message` (including `reasoning` + thinking signatures + `stream`) and `tool/call` byte-for-byte identical.
  3. Reconstructs `attachments/v1/objects/`, `file-objects/`, and `files/<2hex>/<sha256>/<ref.name>`, updates `storages/workspace.json` v2 cleanly, and deletes stale `storages/session_projcache/sessions/<id>.json`.
  4. Fast-forward appends new turns cleanly; divergent edits on the same `sessionId` preserve local `sessionId` and create a valid V4 `branchId` session with `session-log-deepseek/delivery-accepted.data.sessionId` rewritten to `branchId` and zero `seq` shift.
- [ ] **Step 2: Run test to verify failure**
  Run: `Push-Location "d:\AI&Agent_learning\dsh-soul-sync"; node --test tests/session-plane.test.js; Pop-Location`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).
- [ ] **Step 3: Implement `lib/session-plane.js`**
  Implement both offline filesystem persistence adapter and live Cordis runtime adapter (`ctx.sessionPersistence`, `ctx.workspaceRegistry`, `ctx.storageDomain`).
- [ ] **Step 4: Run test to verify pass**
  Run: `Push-Location "d:\AI&Agent_learning\dsh-soul-sync"; node --test tests/session-plane.test.js; Pop-Location`
  Expected: PASS.

---

### Task 3: Deliverable Plane — Provenance Ledger, Container Guard Worker & 3-Way Merge Engine

**Files:**
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\artifact-worker.js`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\deliverable-plane.js`
- Test: `d:\AI&Agent_learning\dsh-soul-sync\tests\deliverable-plane.test.js`

- [ ] **Step 1: Write failing tests for provenance filtering, torn `.xlsx` rejection, secret/symlink blocking, and 3-way merge**
  Create `tests/deliverable-plane.test.js` asserting:
  1. Pre-existing legacy `.xlsx`/`.csv` files and `git ls-files` tracked `.py` files are NOT uploaded, whereas `outputs/model.xlsx`, tool-written `scripts/dcf.py`, watcher-observed new outputs, and `/soul keep` files ARE tracked, and subsequent manual edits to tracked Excel files are captured.
  2. Half-written `.xlsx` missing ZIP EOCD (`PK\x05\x06`) or `.pdf` missing `%%EOF` is rejected as `deferred-retry` and never enters `blobs/`.
  3. `.env`, `*credential*`, hardcoded `sk-...` API keys in `.py`, symlinks escaping workspace, and `~$model.xlsx` lock files are blocked; active `~$model.xlsx` on target stages incoming updates to `.dsh-incoming/` instead of failing.
  4. 3-way merge fast-forwards clean updates, writes `估值表 (来自win-pc ...).xlsx` on dual offline modification, and moves remote-deleted files into `~/.dsh/trash/<wsId>/` instead of hard-deleting.
- [ ] **Step 2: Run test to verify failure**
  Run: `Push-Location "d:\AI&Agent_learning\dsh-soul-sync"; node --test tests/deliverable-plane.test.js; Pop-Location`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).
- [ ] **Step 3: Implement `lib/artifact-worker.js` and `lib/deliverable-plane.js`**
  Implement bounded `worker_threads` verifier, container magic/trailer checks, secret regex + filename guards, and stateful 3-way merge.
- [ ] **Step 4: Run test to verify pass**
  Run: `Push-Location "d:\AI&Agent_learning\dsh-soul-sync"; node --test tests/deliverable-plane.test.js; Pop-Location`
  Expected: PASS.

---

### Task 4: First-Person Compaction Engine (`dsh-compaction-soul`), Cordis Host Plugin & `/soul` Workflow Skill

**Files:**
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\compaction-soul.js`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\lib\index.js`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\skills\soul-handoff\SKILL.md`

- [ ] **Step 1: Write `lib/compaction-soul.js` subclassing `BasicCompactionEngine` (with graceful standalone fallback)**
  Override `summarize()` to replay prefix verbatim (preserving provider KV Cache) and issue the first-person native-language prompt with the 6 cognitive sections + `Flash → V4Pro` visual-to-text bridge + `retainRatio: 0.25`; export preset patch injector for `desktop` and `web` `cordis.patch.yml`.
- [ ] **Step 2: Write `lib/index.js` Cordis Host plugin & `/soul` command handler**
  Wire `session/event` (`step/end` 30s RPO, `turn/end`), `session/disposed` (frozen read without `ctx.sessions.flush`), `job/settled`, `tools/result`, `agent/pre-step` (inject persistent first-person `【跨设备接力备注】` when OS/device switched + `Flash ⇄ V4Pro` tier notice), startup silent pull, global `AGENTS.md` sync, and `/soul` (`status`, `handoff`, `pull`, `push`, `keep`, `config`).
- [ ] **Step 3: Author `skills/soul-handoff/SKILL.md`**
  Provide structured instructions for `/soul handoff` first-person diary generation, `Flash → V4Pro` chart/image summarization, Windows-only raw data gap declaration, and multi-session `workflow` synthesis.

---

### Task 5: Cross-OS CLI, One-Click Installers, Documentation & Live DSH Sandbox E2E Verification

**Files:**
- Create: `d:\AI&Agent_learning\dsh-soul-sync\bin\dsh-soul.js`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\scripts\install-win.ps1`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\scripts\install-mac.sh`
- Create: `d:\AI&Agent_learning\dsh-soul-sync\README.md`
- Test: `d:\AI&Agent_learning\dsh-soul-sync\tests\dsh-integration.test.js`

- [ ] **Step 1: Implement `bin/dsh-soul.js`, `scripts/install-win.ps1`, `scripts/install-mac.sh`, and `README.md`**
  Auto-detect DSH Desktop bundled Node/CLI on Windows (`%LOCALAPPDATA%\Programs\DeepSeek Harness\...`) and macOS (`/Applications/DeepSeek Harness.app/...`), bypass `cmd.exe` `&` path splitting by invoking Electron/Node CLI directly, prompt for vault path + optional encryption passphrase + workspace path mappings + quotas, install bundle into both `desktop` and `web` profiles, patch preset compaction, install `soul-handoff` skill, and seed global `AGENTS.md`.
- [ ] **Step 2: Write and run live DSH sandbox integration test (`tests/dsh-integration.test.js`)**
  Mount `dsh-soul-sync` into an isolated `$DSH_HOME` using the real local DSH `0.2.2-rc.1` runtime, verify `dsh --profile web --dump-config` resolves both `dsh-soul-sync` and `dsh-compaction-soul`, and execute a full simulated Windows → Encrypted Vault → Mac → Encrypted Vault → Windows session + `.py`/`.xlsx` deliverable + split-brain roundtrip!
- [ ] **Step 3: Run full test suite & verify clean state**
  Run: `Push-Location "d:\AI&Agent_learning\dsh-soul-sync"; node --test tests/*.test.js; Pop-Location`
  Expected: 100% PASS across all 4 test files, and `git status` inside `d:\AI&Agent_learning\invest-copilot` remains 100% untouched.
