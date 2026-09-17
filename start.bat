@echo off
chcp 65001 >nul
title AI演说家 - 智能演讲辅导平台

echo ========================================
echo    AI演说家 - 智能演讲辅导平台
echo ========================================
echo.

cd /d "%~dp0"

:: Check Python
echo [1/5] 检查 Python 环境...
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Python，请先安装 Python 3.11+
    pause
    exit /b 1
)

:: Check/Create virtual environment
echo [2/5] 检查虚拟环境...
if not exist "backend\.venv" (
    echo 正在创建虚拟环境...
    cd backend
    python -m venv .venv
    cd ..
)

:: Activate venv and install dependencies
echo [3/5] 安装后端依赖...
call backend\.venv\Scripts\activate.bat
pip install -r backend\requirements.txt -q

:: Check .env file
if not exist "backend\.env" (
    echo [警告] 未找到 backend\.env 文件
    echo 请先配置 API 密钥，参考 backend\.env.example
    echo.
    copy backend\.env.example backend\.env >nul
    echo 已创建 backend\.env 文件，请填写真实的 API 密钥后重新运行
    notepad backend\.env
    pause
    exit /b 1
)

:: Start backend
echo [4/5] 启动后端服务...
cd backend
start /b python -m uvicorn main:app --host 0.0.0.0 --port 8000
cd ..

:: Wait for backend
echo 等待后端服务就绪...
timeout /t 3 /nobreak >nul

:: Check if frontend dependencies installed
echo [5/5] 检查前端环境...
if not exist "frontend\node_modules" (
    echo 正在安装前端依赖 (首次运行需要较长时间)...
    cd frontend
    call npm install
    cd ..
)

:: Start frontend
echo 启动前端服务...
cd frontend
start /b npm run dev

:: Wait for frontend
timeout /t 3 /nobreak >nul

:: Open browser
echo.
echo ========================================
echo   服务已启动!
echo   前端地址: http://127.0.0.1:5173
echo   后端地址: http://localhost:8000
echo ========================================
echo.
echo 正在打开浏览器...
start msedge http://127.0.0.1:5173

echo.
echo 按任意键停止所有服务...
pause >nul

:: Kill processes
taskkill /f /im node.exe >nul 2>&1
taskkill /f /im python.exe >nul 2>&1

echo 服务已停止
