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

  # Create predictable top-level app.js / style.css pointing to the built assets
  # so whitepaper.html can load /static/app.js and /static/style.css without 404.
  echo "[TREATZ] 📦 Creating predictable asset names for whitepaper..."

  # find first JS asset (the Vite entry bundle) and copy to static/app.js
  JS_FILE=$(ls static/assets/*.js 2>/dev/null | head -n 1 || true)
  if [ -n "$JS_FILE" ]; then
    cp -f "$JS_FILE" static/app.js
    echo "[TREATZ] Copied $JS_FILE -> static/app.js"
  else
    echo "[TREATZ] ⚠️ No JS built asset found in static/assets/ (app.js not created)" >&2
  fi

  # find first CSS asset (optional — not all builds emit CSS) and copy to static/style.css
  CSS_FILE=$(ls static/assets/*.css 2>/dev/null | head -n 1 || true)
  if [ -n "$CSS_FILE" ]; then
    cp -f "$CSS_FILE" static/style.css
    echo "[TREATZ] Copied $CSS_FILE -> static/style.css"
  else
    echo "[TREATZ] ℹ️ No CSS asset found to copy (style.css not created)."
  fi

else
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

echo "[TREATZ] ✅ Build complete!"
