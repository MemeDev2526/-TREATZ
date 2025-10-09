#!/usr/bin/env bash
set -euo pipefail

echo "[TREATZ] 🚀 Starting Render build…"

# ---- Python venv (optional) ----
if [ -f requirements.txt ]; then
  if [ -f .venv/bin/activate ]; then
    source .venv/bin/activate
  else
    python3 -m venv .venv
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

# ---- Vite build (once) ----
echo "[TREATZ] 🛠️  Building site with Vite…"
npm run build

# ---- Install build into /static ----
if [ ! -d "dist" ]; then
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

rm -rf static
mkdir -p static
cp -a dist/. static/

# Also keep raw repo assets under /static/assets
mkdir -p static/assets
if [ -d "assets" ]; then
  cp -a assets/. static/assets/
fi

# Ship repo-root style.css at a stable URL
if [ -f "style.css" ]; then
  cp -f "style.css" static/style.css
  echo "[TREATZ] Copied repo-root style.css -> /static/style.css"
else
  echo "[TREATZ] ⚠️ repo-root style.css not found"
fi

# If we have a Vite manifest, copy its entry to static/app.js for fast-path
if [ -f "static/manifest.json" ]; then
  JS_ENTRY=$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync("./static/manifest.json","utf8"));const v=Object.values(m);const e=v.find(x=>x&&x.isEntry&&x.file)||v.find(x=>x&&x.file);if(e&&e.file)process.stdout.write(e.file);')
  if [ -n "${JS_ENTRY:-}" ] && [ -f "static/$JS_ENTRY" ]; then
    cp -f "static/$JS_ENTRY" static/app.js
    echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (fast-path)"
  fi
elif [ -f "static/.vite/manifest.json" ]; then
  JS_ENTRY=$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync("./static/.vite/manifest.json","utf8"));const v=Object.values(m);const e=v.find(x=>x&&x.isEntry&&x.file)||v.find(x=>x&&x.file);if(e&&e.file)process.stdout.write(e.file);')
  if [ -n "${JS_ENTRY:-}" ] && [ -f "static/$JS_ENTRY" ]; then
    cp -f "static/$JS_ENTRY" static/app.js
    echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (fallback from .vite manifest)"
  fi
fi

# 🔧 Ensure /static/index.html actually references /static/style.css
if [ -f static/index.html ]; then
  if ! grep -q '/static/style.css' static/index.html; then
    echo "[TREATZ] Injecting <link> for /static/style.css into static/index.html"
    # Use commit SHA or timestamp as a cache-buster
    VER="${RENDER_GIT_COMMIT:-$(date +%s)}"
    awk -v ver="$VER" '
      BEGIN { done=0 }
      /<\/head>/ && !done {
        print "  <link rel=\"stylesheet\" href=\"/static/style.css?v=" ver "\">"
        done=1
      }
      { print }
    ' static/index.html > static/index.html.tmp && mv static/index.html.tmp static/index.html
  fi
fi

# Sanity logs
echo "[TREATZ] 📦 Contents of static/:"
ls -la static || true
echo "[TREATZ] 🔎 Manifest present?"
[ -f static/manifest.json ] && echo "manifest.json: yes" || echo "manifest.json: no"
[ -f static/.vite/manifest.json ] && echo ".vite/manifest.json: yes" || echo ".vite/manifest.json: no"

echo "[TREATZ] ✅ Build complete!"
