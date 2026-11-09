@echo off
REM 用系统默认浏览器打开 SVG 编辑器（避免被当成下载/文本）
set "DIR=%~dp0"
start "" "%DIR%index.html"
