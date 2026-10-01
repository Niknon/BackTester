@echo off
chcp 65001 >nul
title BackTester
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Не найден Node.js. Скачайте и установите его: https://nodejs.org  (кнопка LTS)
  echo     После установки запустите этот файл ещё раз.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости, это займёт 1-3 минуты...
  call npm install
  if errorlevel 1 (
    echo [!] Ошибка установки зависимостей.
    pause
    exit /b 1
  )
)

if not exist dist\index.html (
  echo Собираю приложение...
  call npm run build
  if errorlevel 1 (
    echo [!] Ошибка сборки.
    pause
    exit /b 1
  )
)

echo.
echo BackTester запущен: http://localhost:8080
echo Не закрывайте это окно, пока пользуетесь программой.
echo.
start "" http://localhost:8080
node server\server.mjs
pause
