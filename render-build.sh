#!/usr/bin/env bash
set -euo pipefail

echo "[TREATZ] 🚀 Starting Render build…"

# Activate or create virtual env
if [ -d ".venv" ]; then
  source .venv/bin/activate
else
  python3 -m venv .venv
  source .venv/bin/activate
fi

# Python deps
python3 -V
pip install --upgrade pip
pip install -r requirements.txt

# Frontend deps
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# Frontend build (Vite)
npm run build || true

# Move build output to static/
rm -rf static || true
mkdir -p static
cp -r dist/* static/

echo "[TREATZ] ✅ Build complete!"