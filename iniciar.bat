@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Roleta Musical - TikTok LIVE
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale a versao LTS em https://nodejs.org/ e abra este arquivo novamente.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Preparando o conector na primeira execucao...
  call npm install
  if errorlevel 1 (echo Falha ao instalar dependencias.& pause & exit /b 1)
)
start "Roleta Musical" http://127.0.0.1:21213
node server.js
pause
