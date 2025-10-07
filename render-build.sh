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
echo "[TREATZ] 🛠️  Building site with Vite..."
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

  echo "[TREATZ] 📦 Ensuring predictable top-level app.js / style.css..."

  # If build:app created static/app.js, keep it. Otherwise try manifest fallback.
  if [ -f "static/app.js" ]; then
    echo "[TREATZ] static/app.js already exists (from build:app)"
  else
    # Use manifest.json to reliably pick the main entry file
    if [ -f "static/manifest.json" ]; then
      # Node one-liner: find first entry with isEntry = true
      JS_ENTRY=$(node -e 'const fs=require("fs"); const m=require("./static/manifest.json"); for(const k in m){ if(m[k]&&m[k].isEntry){ console.log(m[k].file); process.exit(0);} } const values=Object.values(m); for(const v of values){ if(v && v.file && v.file.endsWith(".js")){ console.log(v.file); process.exit(0); } } process.exit(0);')
      if [ -n "$JS_ENTRY" ]; then
        cp -f "static/$JS_ENTRY" static/app.js
        echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (manifest fallback)"
      else
        echo "[TREATZ] ⚠️ Could not find an entry JS in manifest — app.js not created" >&2
      fi
    else
      echo "[TREATZ] ⚠️ manifest.json not found — cannot determine entry JS. Ensure build:app created static/app.js" >&2
    fi
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
