#!/usr/bin/env bash
set -euo pipefail

echo "[TREATZ] 🚀 Starting Render build…"

# ---- Python venv (optional) ----
if [ -f requirements.txt ]; then
  if [ -f .venv/bin/activate ]; then
    # shellcheck disable=SC1091
    source .venv/bin/activate
  else
    python3 -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate
  fi

  python3 -V
  pip install --upgrade pip
  pip install -r requirements.txt
else
  echo "[TREATZ] (no requirements.txt) — skipping Python deps"
fi

# ---- Frontend deps ----
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# ---- Vite build ----
echo "[TREATZ] 🛠️  Building site with Vite…"
npm run build

# ---- Install build into /static ----
if [ -d "dist" ]; then
  rm -rf static
  mkdir -p static
  cp -a dist/. static/

  # also keep raw repo assets under /static/assets
  mkdir -p static/assets
  if [ -d "assets" ]; then
    cp -a assets/. static/assets/
  fi

  # ---- Build app.js NOW so dist→static copy didn’t delete it ----
  if npm run | grep -q "build:app"; then
    echo "[TREATZ] 🧩 Building standalone runtime (app.js)…"
    npm run build:app || echo "[TREATZ] ⚠️ build:app failed — continuing"
  else
    echo "[TREATZ] (no build:app script) — skipping standalone runtime build"
  fi

  # Ensure /static/app.js exists (fallback to Vite manifest if needed)
  if [ -f "static/app.js" ]; then
    echo "[TREATZ] static/app.js present."
  else
    echo "[TREATZ] ℹ️ static/app.js not found; attempting manifest fallback…"
    if [ -f "static/manifest.json" ]; then
      JS_ENTRY=$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync("./static/manifest.json","utf8"));const vals=Object.values(m);const e=vals.find(v=>v&&v.isEntry&&v.file)||vals.find(v=>v&&v.file);if(e&&e.file)process.stdout.write(e.file);')
      if [ -n "${JS_ENTRY:-}" ] && [ -f "static/$JS_ENTRY" ]; then
        cp -f "static/$JS_ENTRY" static/app.js
        echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (fallback)"
      else
        echo "[TREATZ] ⚠️ Couldn’t determine entry from /static/manifest.json; runtime will load via manifest at run-time."
      fi
    elif [ -f "static/.vite/manifest.json" ]; then
      JS_ENTRY=$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync("./static/.vite/manifest.json","utf8"));const vals=Object.values(m);const e=vals.find(v=>v&&v.isEntry&&v.file)||vals.find(v=>v&&v.file);if(e&&e.file)process.stdout.write(e.file);')
      if [ -n "${JS_ENTRY:-}" ] && [ -f "static/$JS_ENTRY" ]; then
        cp -f "static/$JS_ENTRY" static/app.js
        echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (fallback from .vite manifest)"
      else
        echo "[TREATZ] ⚠️ Couldn’t determine entry from .vite manifest; runtime will load via manifest at run-time."
      fi
    else
      echo "[TREATZ] ⚠️ No manifest present; runtime will rely on /static/app.js only if created."
    fi
  fi

  # Always ship repo-root style.css at a stable URL
  if [ -f "style.css" ]; then
    cp -f "style.css" static/style.css
    echo "[TREATZ] Copied repo-root style.css -> /static/style.css"
  else
    echo "[TREATZ] ⚠️ repo-root style.css not found; page will load without /static/style.css"
  fi

  # Sanity logs
  echo "[TREATZ] 📦 Contents of static/:"
  ls -la static || true
  echo "[TREATZ] 🔎 Manifest exists?"
  [ -f static/manifest.json ] && echo "Yes" || echo "No"

else
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

echo "[TREATZ] ✅ Build complete!"
