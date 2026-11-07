#!/usr/bin/env bash
# One-shot setup for pi-auto-mode. Safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODEL="${1:-}"

command -v pi >/dev/null || { echo "pi not found. Install pi first."; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found."; exit 1; }

echo "==> installing @gotgenes/pi-permission-system (>= 40)"
pi install npm:@gotgenes/pi-permission-system@latest

echo "==> installing pi-auto-mode from $HERE"
pi install "$HERE"

# Edit a JSON file via python: fail with a hand-edit hint on non-plain JSON, write atomically.
edit_json() { # file, hint, python body operating on dict `d`
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys, tempfile
p, hint, body = sys.argv[1:4]
try:
    d = json.load(open(p)) if os.path.exists(p) else {}
except json.JSONDecodeError:
    sys.exit(f"{p} is not plain JSON (comments?). {hint}")
exec(body)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p))
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
os.replace(tmp, p)
PY
}

echo "==> freeing shift+tab (thinking cycle -> alt+t)"
mkdir -p "$AGENT_DIR"
edit_json "$AGENT_DIR/keybindings.json" \
  'Set "app.thinking.cycle": ["alt+t"] by hand.' \
  'd.setdefault("app.thinking.cycle", ["alt+t"])'

echo "==> adding auto-mode to authorizerChain"
PERM="$AGENT_DIR/extensions/pi-permission-system/config.json"
mkdir -p "$(dirname "$PERM")"
edit_json "$PERM" \
  'Add "authorizerChain": ["auto-mode"] by hand.' \
  'chain = d.setdefault("authorizerChain", [])
if "auto-mode" not in chain: chain.append("auto-mode")'

CFG="$AGENT_DIR/extensions/pi-auto-mode/config.json"
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  cp "$HERE/examples/config.json" "$CFG"
  if [ -n "$MODEL" ]; then
    MODEL="$MODEL" edit_json "$CFG" 'Set "clef": {"model": ...} by hand.' 'd.setdefault("clef", {})["model"] = os.environ["MODEL"]' 
  fi
  echo "==> wrote $CFG (edit baseUrl/model/apiKey for your OpenAI-compatible endpoint)"
fi

echo "Done. In pi: /reload, then shift+tab or /auto on."
