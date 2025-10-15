#!/usr/bin/env bash
set -euo pipefail

echo "[TREATZ] 🚀 Starting Render build…"

# Build ID for cache-busting (__BUILD__ in HTML/JS)
BUILD_ID="${RENDER_GIT_COMMIT:-$(date +%s)}"
BUILD_ID="${BUILD_ID:0:7}"
echo "[TREATZ] 🧾 BUILD_ID=${BUILD_ID}"

# ---- Optional: Python venv (only if you have requirements.txt) ----
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

# ---- Node deps ----
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# ---- Build site to /static with Vite ----
echo "[TREATZ] 🛠️  Building site with Vite → static/"
npx vite build --base=/static/ --outDir static

# ---- Bundle standalone runtime AFTER vite (esbuild) ----
echo "[TREATZ] 🧩 Bundling app.js with esbuild → static/app.js"
npm run build:app

# Sanity: ensure app.js exists
if [ ! -f static/app.js ]; then
  echo "[TREATZ] ❌ static/app.js missing after build — aborting" >&2
  exit 1
fi

# ---- Keep raw repo assets (images/audio) alongside vite output ----
mkdir -p static/assets
if [ -d "assets" ]; then
  cp -a assets/. static/assets/
fi

# ---- Use your repo HTML (so your robust loader stays in control) ----
if [ -f "index.html" ]; then
  cp -f index.html static/index.html
  echo "[TREATZ] Overrode Vite-built index.html with repo-root index.html"
fi

# ---- Always ship your author CSS (stable path for the site) ----
if [ -f "style.css" ]; then
  cp -f style.css static/style.css
  echo "[TREATZ] Copied repo-root style.css -> /static/style.css"
fi

# ---- Stamp __BUILD__ placeholders (index.html + app.js) ----
if [ -f static/index.html ]; then
  sed -i.bak "s/__BUILD__/${BUILD_ID}/g" static/index.html || true
  rm -f static/index.html.bak
fi
if [ -f static/app.js ]; then
  sed -i.bak "s/__BUILD__/${BUILD_ID}/g" static/app.js || true
  rm -f static/app.js.bak
fi

echo "[TREATZ] 📦 Contents of static/:"
ls -la static || true
[ -f static/manifest.json ] && echo "[TREATZ] ✔ Vite manifest present" || echo "[TREATZ] (no top-level manifest.json — okay if your HTML handles fallback)"

echo "[TREATZ] ✅ Build complete!"