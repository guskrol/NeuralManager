@echo off
setlocal

cd /d "%~dp0"
title NeuraL Farm Control - Rede

echo.
echo ========================================
echo   NeuraL Farm Control - Modo Rede
echo ========================================
echo.
echo Use este arquivo no PC onde o DreamBot vai abrir.
echo Depois acesse este PC a partir de outro computador na mesma rede.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado neste PC.
  echo Instale o Node.js LTS em https://nodejs.org e tente novamente.
  echo.
  pause
  exit /b 1
)

if not exist "server.mjs" (
  echo.
  echo ERRO: server.mjs nao foi encontrado.
  echo Execute este .bat dentro da pasta do NeuraL Farm Control.
  echo.
  pause
  exit /b 1
)

if not exist "data" (
  mkdir "data" >nul 2>nul
)

if not exist "data\accounts.txt" (
  echo Criando data\accounts.txt vazio...
  type nul > "data\accounts.txt"
)

if not exist "data\farm.json" (
  if exist "farm.example.json" (
    echo Criando data\farm.json a partir de farm.example.json...
    copy /Y "farm.example.json" "data\farm.json" >nul
  )
)

if exist "tools\nick-capture-helper\dist\NeuraLNickCapture.jar" (
  if not exist "%USERPROFILE%\DreamBot\Scripts" (
    mkdir "%USERPROFILE%\DreamBot\Scripts" >nul 2>nul
  )
  copy /Y "tools\nick-capture-helper\dist\NeuraLNickCapture.jar" "%USERPROFILE%\DreamBot\Scripts\NeuraLNickCapture.jar" >nul
  echo Helper de nick sincronizado no DreamBot.
) else (
  echo AVISO: helper de nick nao encontrado em tools\nick-capture-helper\dist\NeuraLNickCapture.jar
)

echo IPs deste PC:
ipconfig | findstr /R /C:"IPv4"
echo.
echo No outro PC, acesse:
echo   http://IP_DESTE_PC:3000/
echo.
echo No proprio PC do agent, tambem abrira:
echo   http://127.0.0.1:3000/
echo.
echo Mantenha esta janela aberta enquanto usa o painel.
echo.

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo A porta 3000 ja esta em uso.
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":3000 .*LISTENING"') do set PORT_PID=%%p
  if defined PORT_PID (
    echo Processo usando a porta: PID %PORT_PID%
    tasklist /FI "PID eq %PORT_PID%"
    echo.
    set /p KILL_PORT=Deseja encerrar esse processo e reiniciar o painel? [S/N] 
    if /I "%KILL_PORT%"=="S" (
      taskkill /PID %PORT_PID% /F
      timeout /t 1 /nobreak >nul
      goto START_SERVER
    )
  )
  echo Se o NeuraL Farm Control ja estiver aberto, use o IP acima no navegador.
  echo Se quiser reiniciar, feche a outra janela do agent primeiro.
  echo.
  start "" "http://127.0.0.1:3000/"
  pause
  exit /b 0
)

:START_SERVER
start "" "http://127.0.0.1:3000/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" -BindHost 0.0.0.0

echo.
echo NeuraL Farm Control foi encerrado.
pause
