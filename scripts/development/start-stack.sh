#!/bin/sh
# Brings the local UniversalPOS stack up (idempotent). Safe to run on every project open.
cd "$(dirname "$0")/../.." || exit 0
docker info >/dev/null 2>&1 || { echo "Docker is not running; start Docker Desktop, then run: pnpm stack:up"; exit 0; }
docker compose up -d --wait >/dev/null 2>&1 \
  && echo "UniversalPOS stack is up: web http://127.0.0.1:9180  api http://localhost:8080" \
  || echo "Stack did not become healthy; run: docker compose ps"
