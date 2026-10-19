#!/usr/bin/env bash
# Command Code <-> DeepSeek Harness 互传演示（隔离数据目录，不碰真实 ~/.commandcode 与 ~/.dsh）
# 用法: ./scripts/demo-interop.sh [command-code transcript] [dsh session dir]
#       SESSIONPORT_RESUME=1 ./scripts/demo-interop.sh   # 额外跑真实无头 resume（会调用模型）
set -euo pipefail
cd "$(dirname "$0")/.."

CC_SRC="${1:-$(find "$HOME/.commandcode/projects" -name "*.jsonl" ! -name "*.checkpoints.jsonl" -size +10k | head -1)}"
DSH_SRC="${2:-$(for d in "$HOME"/.dsh/sessions/*/session-*; do [ -f "$d/session.v4.jsonl.zstd" ] && echo "$d"; done | head -1)}"
WORK=".tmp/interop"
rm -rf "$WORK"
mkdir -p "$WORK"

echo "== 源 =="
echo "command-code: $CC_SRC"
echo "dsh:          $DSH_SRC"
echo
echo "== 1/4 Command Code -> IR -> DSH =="
DSH_ID="session-$(node -e "console.log(crypto.randomUUID())")"
node packages/cli/src/index.ts push "commandcode:$CC_SRC" --to dsh \
  --home "$WORK/dsh-home" --id "$DSH_ID" --write-ir "$WORK/cc2dsh.ir.json"
echo
echo "== 2/4 校验 DSH 产物 =="
node packages/cli/src/index.ts verify --agent dsh --home "$WORK/dsh-home" --id "$DSH_ID"

echo
echo "== 3/4 DSH -> IR -> Command Code =="
CC_ID="$(node -e "console.log(crypto.randomUUID())")"
node packages/cli/src/index.ts push "dsh:$DSH_SRC" --to command-code \
  --home "$WORK/cc-home" --id "$CC_ID" --write-ir "$WORK/dsh2cc.ir.json"
CC_FILE="$(find "$WORK/cc-home" -name "$CC_ID.jsonl" | head -1)"

echo
echo "== 4/4 校验 Command Code 产物 =="
node packages/cli/src/index.ts verify --agent command-code --file "$CC_FILE"

echo
echo "手动验证:"
echo "  DSH:          DSH_HOME=$PWD/$WORK/dsh-home 打开 DSH 应用，会话 id = $DSH_ID"
echo "  Command Code: node \"/Applications/Command Code.app/Contents/Resources/app/node_modules/command-code/dist/index.mjs\" -p --session $CC_FILE \"继续\""

if [ "${SESSIONPORT_RESUME:-0}" = "1" ]; then
  echo
  echo "== 额外：真实无头 resume =="
  node packages/cli/src/index.ts verify --agent dsh --home "$WORK/dsh-home" --id "$DSH_ID" --resume || true
  node packages/cli/src/index.ts verify --agent command-code --file "$CC_FILE" --resume
fi
