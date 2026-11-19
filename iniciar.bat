@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale Node.js 22 ou superior em https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencia necessaria... & npm install)
if not exist .env (copy .env.example .env >nul & echo.
echo Configure sua chave TikTools no arquivo .env antes de conectar.
echo Abra o arquivo .env no Bloco de Notas, cole a chave e salve.
pause)
start "Roleta Musical" http://127.0.0.1:21213
node server.js
pause
