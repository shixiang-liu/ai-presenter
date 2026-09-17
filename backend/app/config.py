"""
Application Configuration
"""
from pydantic_settings import BaseSettings
from pathlib import Path

class Settings(BaseSettings):
    # ZhipuAI
    ZHIPU_API_KEY: str = ""
    
    # Baidu ASR
    BAIDU_APP_ID: str = ""
    BAIDU_API_KEY: str = ""
    BAIDU_SECRET_KEY: str = ""
    
    # Paths
    SESSIONS_DIR: Path = Path(__file__).parent.parent / "sessions"
    
    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

settings = Settings()

# Ensure sessions directory exists
settings.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
