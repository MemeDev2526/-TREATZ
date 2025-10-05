#!/usr/bin/env bash
set -euo pipefail

echo "[TREATZ] 🚀 Starting Render build…"

# Activate or create virtual env
if [ -f .venv/bin/activate ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
else
  python3 -m venv .venv
  # shellcheck disable=SC1091
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

# Frontend build (Vite) - allow failure to surface as build error (no || true)
npm run build

# If build produced dist/, move it to static/
if [ -d "dist" ]; then
  rm -rf static
  mkdir -p static
  # copy everything (including hidden), preserve attributes
  cp -a dist/. static/

  # copy raw repo assets into static/assets so both built hashed images
  # and original files are available under /static/assets/
  if [ -d "assets" ]; then
    mkdir -p static/assets
    cp -a assets/. static/assets/
  fi

  cp -f whitepaper.html static/ || true
  echo "[TREATZ] ✅ Copied dist/ → static/ and assets → static/assets/"
else
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

echo "[TREATZ] ✅ Build complete!"
