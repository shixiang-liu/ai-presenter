"""Real-time connection manager used by WebSocket endpoints and background tasks."""

from __future__ import annotations

import asyncio
from typing import Dict, Set

from fastapi import WebSocket


class SessionConnectionManager:
    def __init__(self) -> None:
        self._connections: Dict[str, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()
        # Cache the latest important messages per session so late-joining clients
        # can immediately hydrate state (e.g. analysis progress).
        self._last_messages: Dict[str, Dict[str, dict]] = {}

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            if session_id not in self._connections:
                self._connections[session_id] = set()
            self._connections[session_id].add(websocket)
            print(f"[WS-Manager] Connected: session={session_id} total_sockets={len(self._connections[session_id])}")

            cached = list((self._last_messages.get(session_id) or {}).values())

        # Send cached state outside lock.
        for msg in cached:
            try:
                await websocket.send_json(msg)
            except Exception:
                # If hydrate fails, ignore; future broadcasts may still work.
                break

    async def disconnect(self, session_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            if session_id not in self._connections:
                return
            self._connections[session_id].discard(websocket)
            remaining = len(self._connections[session_id])
            print(f"[WS-Manager] Disconnected: session={session_id} remaining_sockets={remaining}")
            if not self._connections[session_id]:
                del self._connections[session_id]

    async def connection_count(self, session_id: str) -> int:
        async with self._lock:
            return len(self._connections.get(session_id, set()))

    async def broadcast(self, session_id: str, message: dict) -> None:
        msg_type = message.get("type", "")

        # Cache progress/state messages even if no clients are connected.
        cacheable = (
            isinstance(msg_type, str)
            and (
                msg_type.startswith("ppt_analysis.")
                or msg_type.startswith("analysis.")
                or msg_type in ("report.ready",)
            )
        )
        if cacheable:
            async with self._lock:
                if session_id not in self._last_messages:
                    self._last_messages[session_id] = {}
                self._last_messages[session_id][msg_type] = message

        async with self._lock:
            sockets = list(self._connections.get(session_id, set()))
        if msg_type.startswith("asr."):
            print(f"[WS-Broadcast] session={session_id} type={msg_type} sockets={len(sockets)}")

        if not sockets:
            return

        # Send concurrently so one slow/broken socket doesn't delay all others.
        # If a socket can't keep up, drop it to keep realtime data flowing.
        async def _send_one(ws: WebSocket) -> WebSocket | None:
            try:
                await asyncio.wait_for(ws.send_json(message), timeout=0.5)
                return None
            except Exception as e:
                if msg_type.startswith("asr."):
                    print(f"[WS-Broadcast] send failed: {e}")
                return ws

        failed = [ws for ws in await asyncio.gather(*(_send_one(ws) for ws in sockets)) if ws is not None]
        if failed and msg_type.startswith("asr."):
            print(f"[WS-Broadcast] {len(failed)} socket(s) failed, disconnecting")
        for ws in failed:
            try:
                await self.disconnect(session_id, ws)
            except Exception:
                pass

    async def send(self, websocket: WebSocket, message: dict) -> None:
        await websocket.send_json(message)


manager = SessionConnectionManager()
