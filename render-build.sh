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

# ---- Build site with Vite (HTML/CSS/assets go to dist/) ----
echo "[TREATZ] 🛠️  Building site with Vite…"
npm run build

# ---- Copy dist → static (this wipes/creates static fresh) ----
if [ -d "dist" ]; then
  rm -rf static
  mkdir -p static
  cp -a dist/. static/

  # keep raw repo assets under /static/assets too (images/audio you keep in /assets)
  mkdir -p static/assets
  if [ -d "assets" ]; then
    cp -a assets/. static/assets/
  fi
else
  echo "[TREATZ] ⚠️ dist/ not found after build — aborting" >&2
  exit 1
fi

# ---- Build standalone runtime AFTER the dist→static copy ----
# This ensures static/app.js is created last and not deleted by the copy above.
if npm run | grep -q "build:app"; then
  echo "[TREATZ] 🧩 Building standalone runtime (app.js)…"
  npm run build:app || echo "[TREATZ] ⚠️ build:app failed — continuing"
else
  echo "[TREATZ] (no build:app script) — skipping standalone runtime build"
fi

# ---- Ensure /static/app.js exists; if not, fallback to Vite manifest entry ----
if [ -f "static/app.js" ]; then
  echo "[TREATZ] ✅ static/app.js present."
else
  echo "[TREATZ] ℹ️ static/app.js not found; attempting manifest fallback…"
  PICK_JS_FROM_MANIFEST() {
    local mf="$1"
    node -e '
      const fs=require("fs");
      const mf=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const vals=Object.values(mf||{});
      // Prefer entries that look like main/app/index
      const prefer = v => v && v.isEntry && /(?:^|\/)(index|main|app)\.[-\w]*\.js$/i.test(v.file||"");
      const ok = vals.find(prefer) || vals.find(v=>v && v.isEntry && /\.js$/i.test(v.file||"")) || vals.find(v=>v && /\.js$/i.test(v.file||""));
      if (ok && ok.file) process.stdout.write(ok.file);
    ' "$mf"
  }

  JS_ENTRY=""
  if [ -f "static/manifest.json" ]; then
    JS_ENTRY=$(PICK_JS_FROM_MANIFEST "static/manifest.json" || true)
  elif [ -f "static/.vite/manifest.json" ]; then
    JS_ENTRY=$(PICK_JS_FROM_MANIFEST "static/.vite/manifest.json" || true)
  fi

  if [ -n "${JS_ENTRY:-}" ] && [ -f "static/$JS_ENTRY" ]; then
    cp -f "static/$JS_ENTRY" static/app.js
    echo "[TREATZ] Copied static/$JS_ENTRY -> static/app.js (fallback)"
  else
    echo "[TREATZ] ⚠️ Couldn’t determine a JS entry from manifest; runtime will load via manifest at run-time."
  fi
fi

# ---- Always ship a stable /static/style.css (your repo-root author CSS) ----
if [ -f "style.css" ]; then
  cp -f "style.css" static/style.css
  echo "[TREATZ] Copied repo-root style.css -> /static/style.css"
else
  echo "[TREATZ] ⚠️ repo-root style.css not found; page will rely on Vite CSS only"
fi

# ---- Sanity logs ----
echo "[TREATZ] 📦 Contents of static/:"
ls -la static || true
echo "[TREATZ] 🔎 Manifest exists?"
[ -f static/.vite/manifest.json ] && echo "Yes (.vite/manifest.json)" || echo "No"

echo "[TREATZ] ✅ Build complete!"
