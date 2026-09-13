@echo off
chcp 65001 >nul
title Corvas
cd /d "%~dp0"
echo.
echo   Corvas - Starting Electron App...
echo.
npm run electron:dev
