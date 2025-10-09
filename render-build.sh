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

# Build the standalone runtime app (esbuild / scripts/build-app.js)
# This produces static/app.js that Vite will not overwrite.
echo "[TREATZ] 🧩 Building standalone runtime (app.js)..."
if npm run build:app; then
  echo "[TREATZ] ✅ build:app finished"
else
  echo "[TREATZ] ⚠️ build:app failed — aborting" >&2
  exit 1
fi

# Frontend build (Vite)
echo "[TREATZ] 🧩 Building standalone runtime (app.js)..."
npm run build:app

echo "[TREATZ] 🛠️  Building site with Vite..."
npm run build

# If build produced dist/, move it to static/
if [ -d "dist" ]; then
  rm -rf static
  mkdir -p static

  # Copy Vite output (including .vite/manifest.json) under /static
  cp -a dist/. static/

  # Also copy raw repo assets so /static/assets has your images/sounds
  mkdir -p static/assets
  if [ -d "assets" ]; then
    cp -a assets/. static/assets/
  fi

  # Keep the standalone runtime we built earlier
  if [ -f "static/app.js" ]; then
    echo "[TREATZ] static/app.js present."
  else
    echo "[TREATZ] ℹ️ static/app.js not found; attempting manifest fallback…"
    if [ -f "static/.vite/manifest.json" ]; then
      JS_ENTRY=$(node -e 'const m=require("./static/.vite/manifest.json"); const e=Object.values(m).find(v=>v&&v.isEntry&&v.file)||Object.values(m).find(v=>v&&v.file); if(e&&e.file) console.log(e.file);')
      if [ -n "$JS_ENTRY" ] && [ -f "static/$JS_ENTRY" ]; then
        cp -f "static/$JS_ENTRY" static/app.js
        echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (fallback)"
      else
        echo "[TREATZ] ⚠️ Couldn’t determine entry from manifest; runtime will use manifest at load."
      fi
    else
      echo "[TREATZ] ⚠️ No manifest present; runtime will rely on /static/app.js only if created."
    fi
# do NOT exit here – proceed

  # SIMPLE & RELIABLE: ensure /static/style.css from repo root
  if [ -f "style.css" ]; then
    cp -f "style.css" static/style.css
    echo "[TREATZ] Copied repo-root style.css -> /static/style.css"
  else
    echo "[TREATZ] ⚠️ repo-root style.css not found; page will load without /static/style.css"
  fi

else
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

echo "[TREATZ] ✅ Build complete!"
