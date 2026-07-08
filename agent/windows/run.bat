@echo off
REM ============================================================
REM  Windows Monitor Agent 便捷启动脚本
REM  1) 修改下面三个变量（在监控后台「添加 Agent」后获得）
REM  2) 双击本文件即可运行（终端关闭即停止上报）
REM  注册为开机自启请改用 install.ps1 -RegisterTask
REM ============================================================
set SERVER_URL=https://your-monitor-server.example.com
set AGENT_ID=win-pc-01
set AGENT_TOKEN=your-agent-token-here
set DISK_PATH=C:\
set INTERVAL=15

python "%~dp0windows_agent.py"
pause
