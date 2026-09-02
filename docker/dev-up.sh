#!/bin/bash
set -e

if [ "$EUID" -ne 0 ]; then
    echo "Este script necesita sudo (grupo docker no activo todavía en esta sesión)."
    echo "Corre: sudo $0"
    exit 1
fi

cd "$(dirname "$0")/.."

echo "=== docker compose up --build -d ==="
docker compose up --build -d

echo ""
echo "=== docker compose ps ==="
docker compose ps

echo ""
echo "=== logs: db (últimas 50) ==="
docker compose logs db --tail=50

echo ""
echo "=== logs: backend (últimas 50) ==="
docker compose logs backend --tail=50
