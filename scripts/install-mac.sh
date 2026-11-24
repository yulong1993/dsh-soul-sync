#!/usr/bin/env bash
set -euo pipefail

DSH_HOME_ARG=""
VAULT_ARG=""
PASSPHRASE_ARG=""
HAS_PASSPHRASE=0
NO_PASSPHRASE=0
DEVICE_LABEL_ARG=""
SKIP_DESKTOP=0
SKIP_WEB=0
NON_INTERACTIVE=0
MAP_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home)
      DSH_HOME_ARG="$2"; shift 2 ;;
    --dsh-home=*)
      DSH_HOME_ARG="${1#*=}"; shift ;;
    --vault)
      VAULT_ARG="$2"; shift 2 ;;
    --vault=*)
      VAULT_ARG="${1#*=}"; shift ;;
    --passphrase)
      PASSPHRASE_ARG="$2"; HAS_PASSPHRASE=1; shift 2 ;;
    --passphrase=*)
      PASSPHRASE_ARG="${1#*=}"; HAS_PASSPHRASE=1; shift ;;
    --no-passphrase)
      NO_PASSPHRASE=1; shift ;;
    --device-label)
      DEVICE_LABEL_ARG="$2"; shift 2 ;;
    --device-label=*)
      DEVICE_LABEL_ARG="${1#*=}"; shift ;;
    --map)
      MAP_ARGS+=("$2"); shift 2 ;;
    --map=*)
      MAP_ARGS+=("${1#*=}"); shift ;;
    --skip-desktop)
      SKIP_DESKTOP=1; shift ;;
    --skip-web)
      SKIP_WEB=1; shift ;;
    --non-interactive)
      NON_INTERACTIVE=1; shift ;;
    -h|--help)
      echo "用法: bash scripts/install-mac.sh [--dsh-home <dir>] [--vault <dir>] [--passphrase <str> | --no-passphrase] [--map <id=win::mac>] [--skip-desktop] [--skip-web] [--non-interactive]"
      exit 0 ;;
    *)
      echo "未知参数: $1" >&2
      exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PARENT="$(dirname "$REPO_ROOT")"
REPO_NAME="$(basename "$REPO_ROOT")"
CLI_ENTRY="$REPO_ROOT/bin/dsh-soul.js"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "找不到 CLI 入口文件: $CLI_ENTRY" >&2
  exit 1
fi

DSH_APP="/Applications/DeepSeek Harness.app"
DSH_ELECTRON="$DSH_APP/Contents/MacOS/DeepSeek Harness"
DSH_ASAR="$DSH_APP/Contents/Resources/app.asar"
DSH_HOST_CLI="$DSH_ASAR/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
DSH_BUNDLED_NODE="$DSH_APP/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"

NODE_BIN=""
if [ -x "$DSH_BUNDLED_NODE" ]; then
  NODE_BIN="$DSH_BUNDLED_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "未找到 Node.js，请先安装 DeepSeek Harness 或 Node.js >= 22.15。" >&2
  exit 1
fi

USE_DIRECT_ELECTRON=0
FALLBACK_DSH=""
if [ -x "$DSH_ELECTRON" ] && [ -e "$DSH_ASAR" ]; then
  USE_DIRECT_ELECTRON=1
elif command -v dsh >/dev/null 2>&1; then
  FALLBACK_DSH="$(command -v dsh)"
else
  echo "未检测到 /Applications/DeepSeek Harness.app 或 dsh 命令。" >&2
  exit 1
fi

echo "=== dsh-soul-sync macOS 一键安装器 ==="
echo "Node 运行时: $NODE_BIN"
if [ "$USE_DIRECT_ELECTRON" -eq 1 ]; then
  echo "DSH CLI: 直连内置 Electron 宿主 ($DSH_ELECTRON)"
else
  echo "DSH CLI: 系统 dsh ($FALLBACK_DSH)"
fi

if [ "$SKIP_DESKTOP" -eq 0 ]; then
  if pgrep -x "DeepSeek Harness" >/dev/null 2>&1; then
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
      echo "警告: 检测到 DeepSeek Harness 桌面端正在运行，建议安装完成后重启桌面端，或传入 --skip-desktop。" >&2
    else
      echo ""
      echo "检测到 DeepSeek Harness 桌面端正在运行（菜单栏/程序坞）。"
      echo "为避免 profile 文件并发冲突，请先彻底退出 DeepSeek Harness（Cmd+Q），然后按回车继续..."
      read -r _
    fi
  fi
fi

INIT_ARGS=("$CLI_ENTRY" "init")
if [ -n "$DSH_HOME_ARG" ]; then
  INIT_ARGS+=("--dsh-home" "$DSH_HOME_ARG")
fi
if [ "$NON_INTERACTIVE" -eq 1 ]; then
  INIT_ARGS+=("--non-interactive")
fi
if [ -n "$VAULT_ARG" ]; then
  INIT_ARGS+=("--vault" "$VAULT_ARG")
fi
if [ "$NO_PASSPHRASE" -eq 1 ]; then
  INIT_ARGS+=("--no-passphrase")
elif [ "$HAS_PASSPHRASE" -eq 1 ]; then
  if [ -z "$PASSPHRASE_ARG" ]; then
    INIT_ARGS+=("--no-passphrase")
  else
    INIT_ARGS+=("--passphrase" "$PASSPHRASE_ARG")
  fi
fi
if [ -n "$DEVICE_LABEL_ARG" ]; then
  INIT_ARGS+=("--device-label" "$DEVICE_LABEL_ARG")
fi
if [ ${#MAP_ARGS[@]} -gt 0 ]; then
  for m in "${MAP_ARGS[@]}"; do
    INIT_ARGS+=("--map" "$m")
  done
fi

echo ""
echo "[1/3] 正在初始化 Soul Sync 配置、金库与接力技能..."
"$NODE_BIN" "${INIT_ARGS[@]}"

PROFILES=()
if [ "$SKIP_WEB" -eq 0 ]; then
  PROFILES+=("web")
fi
if [ "$SKIP_DESKTOP" -eq 0 ]; then
  PROFILES+=("desktop")
fi

echo ""
echo "[2/3] 正在向 DSH profile 注册 dsh-soul-sync 插件包..."
run_dsh_plugin_add() {
  local profile="$1"
  local rel_bundle="./$REPO_NAME"
  local output=""
  local status=0

  echo "  -> 安装到 profile: $profile ($rel_bundle)"
  set +e
  if [ "$USE_DIRECT_ELECTRON" -eq 1 ]; then
    if [ -n "$DSH_HOME_ARG" ]; then
      output="$(cd "$REPO_PARENT" && ELECTRON_RUN_AS_NODE=1 DSH_HOME="$DSH_HOME_ARG" "$DSH_ELECTRON" --expose-internals "$DSH_HOST_CLI" plugin --profile "$profile" add "$rel_bundle" 2>&1)"
    else
      output="$(cd "$REPO_PARENT" && ELECTRON_RUN_AS_NODE=1 "$DSH_ELECTRON" --expose-internals "$DSH_HOST_CLI" plugin --profile "$profile" add "$rel_bundle" 2>&1)"
    fi
    status=$?
  else
    if [ -n "$DSH_HOME_ARG" ]; then
      output="$(cd "$REPO_PARENT" && DSH_HOME="$DSH_HOME_ARG" "$FALLBACK_DSH" plugin --profile "$profile" add "$rel_bundle" 2>&1)"
    else
      output="$(cd "$REPO_PARENT" && "$FALLBACK_DSH" plugin --profile "$profile" add "$rel_bundle" 2>&1)"
    fi
    status=$?
  fi
  set -e

  if [ -n "$output" ]; then
    echo "$output"
  fi
  if [ "$status" -ne 0 ]; then
    if echo "$output" | grep -Eqi "already[[:space:]]+(installed|exists|added)"; then
      echo "  [已安装] profile $profile 已包含 dsh-soul-sync，幂等跳过。"
    else
      echo "向 profile $profile 安装插件失败，退出码: $status" >&2
      return "$status"
    fi
  fi
  return 0
}

if [ ${#PROFILES[@]} -gt 0 ]; then
  for p in "${PROFILES[@]}"; do
    run_dsh_plugin_add "$p"
  done
fi

echo ""
echo "[3/3] 正在运行 dsh-soul doctor 健康体检..."
DOCTOR_ARGS=("$CLI_ENTRY" "doctor")
if [ -n "$DSH_HOME_ARG" ]; then
  DOCTOR_ARGS+=("--dsh-home" "$DSH_HOME_ARG")
fi
"$NODE_BIN" "${DOCTOR_ARGS[@]}"

echo ""
echo "安装全部完成！请重启 DeepSeek Harness，在对话框输入 /soul status 即可查看双机体检卡。"
