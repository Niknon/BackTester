#!/usr/bin/env bash
# Запуск BackTester на macOS / Linux: ./start.sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите его: https://nodejs.org (версия LTS) и запустите скрипт ещё раз."
  exit 1
fi
[ -d node_modules ] || { echo "Первый запуск: устанавливаю зависимости..."; npm install || exit 1; }
[ -f dist/index.html ] || { echo "Собираю приложение..."; npm run build || exit 1; }
echo "BackTester запущен: http://localhost:8080 (Ctrl+C — остановить)"
( sleep 1; (command -v open >/dev/null && open http://localhost:8080) || (command -v xdg-open >/dev/null && xdg-open http://localhost:8080) ) >/dev/null 2>&1 &
node server/server.mjs
