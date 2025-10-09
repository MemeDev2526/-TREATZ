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
    # Use Vite manifest to reliably pick the main entry file
    if [ -f "static/.vite/manifest.json" ]; then
      JS_ENTRY=$(node -e '
        const fs = require("fs");
        const mf = JSON.parse(fs.readFileSync("static/.vite/manifest.json","utf8"));
        // Prefer an entry with isEntry=true, otherwise first file
        for (const k in mf) { const v = mf[k]; if (v && v.isEntry && v.file) { console.log(v.file); process.exit(0); } }
        const first = Object.values(mf).find(v => v && v.file);
        if (first && first.file) { console.log(first.file); }
      ' || true)
      if [ -n "$JS_ENTRY" ] && [ -f "static/$JS_ENTRY" ]; then
        cp -f "static/$JS_ENTRY" static/app.js
        echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (manifest fallback)"
      else
        echo "[TREATZ] ⚠️ Could not find an entry JS in .vite/manifest — app.js not created" >&2
      fi
    else
      echo "[TREATZ] ⚠️ .vite/manifest.json not found — ensure build:app created static/app.js" >&2
    fi

    # --- Stable /static/style.css creation (manifest → assets → repo root) ---
  if [ -f "static/.vite/manifest.json" ]; then
    CSS_ENTRY=$(node -e '
      const fs=require("fs");
      const mf=JSON.parse(fs.readFileSync("static/.vite/manifest.json","utf8"));
      const first=Object.values(mf).find(v=>v && Array.isArray(v.css) && v.css.length);
      if(first) process.stdout.write(first.css[0]);
    ' || true)
    if [ -n "$CSS_ENTRY" ]; then
      SRC="static/${CSS_ENTRY#/}"   # strip leading slash if present
      if [ -f "$SRC" ]; then
        cp -f "$SRC" static/style.css
        echo "[TREATZ] Copied $SRC -> static/style.css (manifest)"
      fi
    fi
  fi

  # fallback 2: first CSS under static/assets/
  if [ ! -f static/style.css ]; then
    CSS_FILE=$(ls static/assets/*.css 2>/dev/null | head -n 1 || true)
    if [ -n "$CSS_FILE" ]; then
      cp -f "$CSS_FILE" static/style.css
      echo "[TREATZ] Copied $CSS_FILE -> static/style.css (assets fallback)"
    fi
  fi

  # fallback 3: repo-root style.css (if you keep one for emergencies)
  if [ ! -f static/style.css ] && [ -f "style.css" ]; then
    cp -f "style.css" static/style.css
    echo "[TREATZ] Copied repo-root style.css -> static/style.css (root fallback)"
  fi

  # final notice
  if [ ! -f static/style.css ]; then
    echo "[TREATZ] ⚠️ No style.css could be created under /static/"
  fi

else
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

echo "[TREATZ] ✅ Build complete!"
