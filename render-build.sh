#!/usr/bin/env bash
set -euo pipefail

# Activate existing venv or create+activate one
if [ -f .venv/bin/activate ]; then
  . .venv/bin/activate
else
  python3 -m venv .venv
  . .venv/bin/activate
fi

# Python deps
pip install --upgrade pip
pip install -r requirements.txt

# Node deps (use package-lock.json if present)
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# Build frontend with Vite (failures are fatal)
npm run build

# Copy Vite output to ./static so FastAPI can serve it
rm -rf static || true
cp -r dist static