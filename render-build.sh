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

# ---- Build site with Vite (puts files in dist/) ----
echo "[TREATZ] 🛠️  Building site with Vite…"
npm run build

# ---- Copy dist → static (fresh) ----
if [ -d "dist" ]; then
  rm -rf static
  mkdir -p static
  cp -a dist/. static/

  # keep raw repo assets (images/audio in /assets) under /static/assets too
  mkdir -p static/assets
  if [ -d "assets" ]; then
    cp -a assets/. static/assets/
  fi
else
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

# ---- Overwrite the built index.html with our repo root index.html ----
# This avoids Vite inserting a hashed HTML entry that imports /static/app.js and /static/style.css.
if [ -f "index.html" ]; then
  cp -f index.html static/index.html
  echo "[TREATZ] Overrode Vite-built index.html with repo-root index.html"
fi

# ---- Build standalone runtime AFTER the dist→static copy ----
echo "[TREATZ] 🧩 Building standalone runtime (app.js)…"
npm run build:app

# ensure we actually have JS before shipping
if [ ! -f static/app.js ]; then
  echo "[TREATZ] ❌ static/app.js missing after build — aborting deploy" >&2
  exit 1
fi


# ---- NEVER copy from a manifest into app.js (that caused the regression) ----

# ---- Always ship a stable /static/style.css (author CSS from repo root) ----
if [ -f "style.css" ]; then
  cp -f style.css static/style.css
  echo "[TREATZ] Copied repo-root style.css -> /static/style.css"
fi

# ---- Sanity logs ----
echo "[TREATZ] 📦 Contents of static/:"
ls -la static || true
echo "[TREATZ] 🔎 Has .vite manifest for other assets?"
[ -f static/.vite/manifest.json ] && echo "Yes (.vite/manifest.json)" || echo "No"

echo "[TREATZ] ✅ Build complete!"
