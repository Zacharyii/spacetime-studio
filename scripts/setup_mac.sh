#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "系统架构: $(uname -m)"
if command -v sw_vers >/dev/null 2>&1; then sw_vers -productVersion; fi
for tool in node npm python3 ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "缺少依赖: $tool。请自行安装后重试；本脚本不会修改系统配置或安装 Homebrew。" >&2
    exit 1
  fi
done
echo "node: $(node --version)"
echo "npm: $(npm --version)"
echo "python: $(python3 --version)"
echo "ffmpeg: $(ffmpeg -version | head -n 1)"
echo "ffprobe: $(ffprobe -version | head -n 1)"
python3 -m venv "$ROOT/backend/.venv"
"$ROOT/backend/.venv/bin/python" -m pip install --upgrade pip
"$ROOT/backend/.venv/bin/python" -m pip install -r "$ROOT/backend/requirements.txt"
mkdir -p "$ROOT/tmp/npm-cache"
(cd "$ROOT/frontend" && npm_config_cache="$ROOT/tmp/npm-cache" npm install --no-audit --no-fund)
"$ROOT/backend/.venv/bin/python" "$ROOT/scripts/generate_fixture.py"
echo "依赖与测试视频准备完成。运行: $ROOT/scripts/start_mac.sh"
