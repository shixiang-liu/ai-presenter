"""
SQLite Database Models and Operations
"""
import aiosqlite
import json
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any

DATABASE_PATH = Path(__file__).parent.parent.parent / "sessions" / "ai_presenter.db"

async def init_db():
    """Initialize database with schema"""
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    
    async with aiosqlite.connect(DATABASE_PATH) as db:
        # Sessions table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                mode TEXT NOT NULL,
                title TEXT,
                duration_ms INTEGER,
                video_path TEXT,
                status TEXT DEFAULT 'recording',
                ppt_path TEXT,
                script_path TEXT,
                ppt_script_path TEXT,
                slides_count INTEGER,
                total_score REAL,
                scores_json TEXT
            )
        """)

        # Lightweight migrations for existing DBs
        try:
            await db.execute("ALTER TABLE sessions ADD COLUMN script_path TEXT")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE sessions ADD COLUMN ppt_script_path TEXT")
        except Exception:
            pass
        
        # Transcript segments table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS transcript_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT NOT NULL,
                slide_index INTEGER,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        
        # Events table (issues and highlights)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                category TEXT NOT NULL,
                severity TEXT,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                evidence_json TEXT,
                slide_index INTEGER,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        
        # Metrics series table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS metrics_series (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                series_json TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        
        # Slides table (for PPT mode)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS slides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                slide_index INTEGER NOT NULL,
                image_path TEXT,
                notes TEXT,
                generated_script TEXT,
                analysis_json TEXT,
                start_ms INTEGER,
                end_ms INTEGER,
                metrics_json TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        
        # Lightweight migration for existing DBs: add analysis_json column
        try:
            await db.execute("ALTER TABLE slides ADD COLUMN analysis_json TEXT")
        except Exception:
            pass
        
        await db.commit()

async def create_session(session_id: str, mode: str, title: Optional[str] = None, ppt_path: Optional[str] = None) -> Dict:
    """Create a new session"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        created_at = datetime.now().isoformat()
        await db.execute(
            "INSERT INTO sessions (id, created_at, mode, title, ppt_path, status) VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, created_at, mode, title, ppt_path, "recording")
        )
        await db.commit()
        return {
            "id": session_id,
            "created_at": created_at,
            "mode": mode,
            "title": title,
            "status": "recording"
        }

async def get_session(session_id: str) -> Optional[Dict]:
    """Get session by ID"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)) as cursor:
            row = await cursor.fetchone()
            if row:
                return dict(row)
    return None

async def update_session(session_id: str, **kwargs) -> bool:
    """Update session fields"""
    if not kwargs:
        return False
    
    fields = ", ".join(f"{k} = ?" for k in kwargs.keys())
    values = list(kwargs.values()) + [session_id]
    
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(f"UPDATE sessions SET {fields} WHERE id = ?", values)
        await db.commit()
        return True

async def delete_session(session_id: str) -> bool:
    """Delete session and all related data"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.commit()
        return True

async def list_sessions(limit: int = 50, offset: int = 0) -> List[Dict]:
    """List all sessions"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset)
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

async def add_transcript_segment(session_id: str, start_ms: int, end_ms: int, text: str, slide_index: Optional[int] = None):
    """Add a transcript segment"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO transcript_segments (session_id, start_ms, end_ms, text, slide_index) VALUES (?, ?, ?, ?, ?)",
            (session_id, start_ms, end_ms, text, slide_index)
        )
        await db.commit()

async def get_transcript_segments(session_id: str) -> List[Dict]:
    """Get all transcript segments for a session"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY start_ms",
            (session_id,)
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

async def add_event(
    session_id: str,
    event_type: str,
    category: str,
    severity: str,
    start_ms: int,
    end_ms: int,
    evidence: Dict,
    slide_index: Optional[int] = None,
) -> int:
    """Add an event (issue or highlight) and return its id."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            """INSERT INTO events (session_id, type, category, severity, start_ms, end_ms, evidence_json, slide_index) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, event_type, category, severity, start_ms, end_ms, json.dumps(evidence, ensure_ascii=False), slide_index)
        )
        await db.commit()
        return int(cursor.lastrowid or 0)

async def get_events(session_id: str) -> List[Dict]:
    """Get all events for a session"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM events WHERE session_id = ? ORDER BY start_ms",
            (session_id,)
        ) as cursor:
            rows = await cursor.fetchall()
            result = []
            for row in rows:
                d = dict(row)
                if d.get('evidence_json'):
                    d['evidence'] = json.loads(d['evidence_json'])
                    del d['evidence_json']
                result.append(d)
            return result

async def add_metrics_series(session_id: str, name: str, series: List):
    """Add a metrics series (e.g., speed_curve, emotion_curve)"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO metrics_series (session_id, name, series_json) VALUES (?, ?, ?)",
            (session_id, name, json.dumps(series))
        )
        await db.commit()

async def get_metrics_series(session_id: str, name: Optional[str] = None) -> List[Dict]:
    """Get metrics series for a session"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        if name:
            query = "SELECT * FROM metrics_series WHERE session_id = ? AND name = ?"
            params = (session_id, name)
        else:
            query = "SELECT * FROM metrics_series WHERE session_id = ?"
            params = (session_id,)
        
        async with db.execute(query, params) as cursor:
            rows = await cursor.fetchall()
            result = []
            for row in rows:
                d = dict(row)
                if d.get('series_json'):
                    d['series'] = json.loads(d['series_json'])
                    del d['series_json']
                result.append(d)
            return result

async def add_slide(session_id: str, slide_index: int, image_path: str, 
                   notes: Optional[str] = None, generated_script: Optional[str] = None,
                   analysis: Optional[Dict] = None):
    """Add a slide record"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        analysis_json = json.dumps(analysis, ensure_ascii=False) if analysis else None
        await db.execute(
            """INSERT INTO slides (session_id, slide_index, image_path, notes, generated_script, analysis_json) 
               VALUES (?, ?, ?, ?, ?, ?)""",
            (session_id, slide_index, image_path, notes, generated_script, analysis_json)
        )
        await db.commit()

async def update_slide(session_id: str, slide_index: int, **kwargs):
    """Update slide fields"""
    if not kwargs:
        return
    
    # Handle analysis dict -> JSON conversion
    if 'analysis' in kwargs:
        analysis_val = kwargs.pop('analysis')
        kwargs['analysis_json'] = json.dumps(analysis_val, ensure_ascii=False) if analysis_val else None
    
    fields = ", ".join(f"{k} = ?" for k in kwargs.keys())
    values = list(kwargs.values()) + [session_id, slide_index]
    
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            f"UPDATE slides SET {fields} WHERE session_id = ? AND slide_index = ?",
            values
        )
        await db.commit()

async def get_slides(session_id: str) -> List[Dict]:
    """Get all slides for a session"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM slides WHERE session_id = ? ORDER BY slide_index",
            (session_id,)
        ) as cursor:
            rows = await cursor.fetchall()
            result = []
            for row in rows:
                d = dict(row)
                if d.get('metrics_json'):
                    d['metrics'] = json.loads(d['metrics_json'])
                    del d['metrics_json']
                if d.get('analysis_json'):
                    d['analysis'] = json.loads(d['analysis_json'])
                    del d['analysis_json']
                result.append(d)
            return result
            return result
