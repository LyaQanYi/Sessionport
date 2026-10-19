#!/usr/bin/env bash
# 30 秒演示：Kimi Code 会话 -> IR -> Claude Code 会话 -> 结构校验
# 用法: ./scripts/demo.sh [kimi-bundle-dir]
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE="${1:-session_fdefc84f-470a-421f-a62e-5ad404eceb82}"
CONFIG="${SESSIONPORT_DEMO_HOME:-.tmp/demo-claude-home}"
SID="$(node -e 'console.log(crypto.randomUUID())')"

rm -rf "$CONFIG"
mkdir -p .tmp
echo "== 1/3 inspect =="
node packages/cli/src/index.ts inspect "kimi:$BUNDLE"

echo
echo "== 2/3 push -> claude-code =="
node packages/cli/src/index.ts push "kimi:$BUNDLE" --to claude-code \
  --config-dir "$CONFIG" --session-id "$SID" --write-ir .tmp/demo.ir.json

CWD="$(node -e 'const b=require("./.tmp/demo.ir.json"); console.log(b.root.meta.cwd || process.cwd())')"

echo
echo "== 3/3 verify =="
node packages/cli/src/index.ts verify --config-dir "$CONFIG" --cwd "$CWD" --session-id "$SID"

echo
echo "生成完毕。手动续聊:"
echo "  CLAUDE_CONFIG_DIR=$CONFIG claude --resume $SID"
echo "  （如需无头冒烟测试，加 --resume: node packages/cli/src/index.ts verify --config-dir $CONFIG --cwd $CWD --session-id $SID --resume）"
