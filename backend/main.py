"""
AI Presenter - FastAPI Backend
Main application entry point
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path
import os

# Change working directory to backend folder
os.chdir(Path(__file__).parent)

from app.api import sessions, websocket, profile
from app.models.database import init_db
from app.config import settings

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events"""
    # Startup
    print("Starting AI Presenter Backend...")
    await init_db()
    print("Database initialized")
    print(f"Sessions directory: {settings.SESSIONS_DIR}")
    
    yield
    
    # Shutdown
    print("Shutting down AI Presenter Backend...")

app = FastAPI(
    title="AI Presenter",
    description="AI-powered presentation coaching platform",
    version="1.0.0",
    lifespan=lifespan
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(sessions.router)
app.include_router(websocket.router)
app.include_router(profile.router)

# Mount static files (for serving session media)
if settings.SESSIONS_DIR.exists():
    app.mount("/media", StaticFiles(directory=str(settings.SESSIONS_DIR)), name="media")

@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "status": "ok",
        "service": "AI Presenter Backend",
        "version": "1.0.0"
    }

@app.get("/health")
async def health_check():
    """Detailed health check"""
    return {
        "status": "healthy",
        "database": "connected",
        "sessions_dir": str(settings.SESSIONS_DIR),
        "api_keys_configured": {
            "zhipu": bool(settings.ZHIPU_API_KEY),
            "baidu": bool(settings.BAIDU_APP_ID and settings.BAIDU_API_KEY)
        }
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=True
    )
