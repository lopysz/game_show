@echo off
setlocal
cd /d "%~dp0"
title Roleta Musical v1.3

echo ================================================
echo       ROLETA MUSICAL v1.3  (conexao gratuita)
echo ================================================
echo Pasta: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado.
  echo Instale o Node.js 20 ou superior em https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\ws" goto instalar
if not exist "node_modules\tiktok-live-connector" goto instalar
goto rodar

:instalar
echo Instalando dependencias pela primeira vez (precisa de internet)...
call npm install
if errorlevel 1 (
  echo ERRO ao instalar. Verifique a internet e tente novamente.
  pause
  exit /b 1
)

:rodar
echo.
echo Painel de controle : http://127.0.0.1:3210
echo Overlay para o OBS : http://127.0.0.1:3210/overlay
echo.
echo Mantenha esta janela aberta enquanto usar a roleta.
echo.
start "" http://127.0.0.1:3210
call node server.js

echo.
echo O conector foi encerrado.
pause
