@echo off
chcp 65001 >nul
title BackTester
cd /d "%~dp0"

rem Восстанавливаем системные пути (могли пропасть при ручной правке Path)
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%PATH%"

rem Ищем node.exe: сначала в PATH, затем в стандартных папках установки
set "NODEDIR="
for %%D in ("%ProgramFiles%\nodejs" "%ProgramW6432%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LOCALAPPDATA%\Programs\nodejs" "%APPDATA%\nvm\current" "%NVM_SYMLINK%" "C:\nodejs") do (
  if not defined NODEDIR if exist "%%~D\node.exe" set "NODEDIR=%%~D"
)
if defined NODEDIR set "PATH=%NODEDIR%;%NODEDIR%\node_modules\npm\bin;%APPDATA%\npm;%PATH%"

node -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Не удалось найти Node.js.
  echo     Проверено: PATH, "%ProgramFiles%\nodejs", "%LOCALAPPDATA%\Programs\nodejs" и др.
  echo.
  echo     1. Откройте папку C:\Program Files\nodejs — есть ли там node.exe?
  echo     2. Если нет — установите Node.js с https://nodejs.org ^(кнопка LTS^),
  echo        галочку "Automatically install the necessary tools" НЕ ставьте.
  echo     3. Если node.exe лежит в другой папке — пришлите путь к нему.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

for /f "delims=" %%V in ('node -v') do echo Найден Node.js %%V

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
