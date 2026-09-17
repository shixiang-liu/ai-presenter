import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import websockets


BACKEND_DIR = Path(__file__).resolve().parents[1]
BASE_URL = "http://127.0.0.1:8000"
WS_BASE = "ws://127.0.0.1:8000"


@dataclass
class UvicornProc:
    proc: subprocess.Popen
    log_lines: list[str]
    _log_thread: threading.Thread

    def stop(self) -> None:
        if self.proc.poll() is not None:
            return
        try:
            if os.name == "nt":
                self.proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
            else:
                self.proc.send_signal(signal.SIGINT)
        except Exception:
            pass

        try:
            self.proc.terminate()
        except Exception:
            pass

    def tail(self, n: int = 120) -> str:
        lines = self.log_lines[-n:]
        return "".join(lines)


def start_uvicorn(python_exe: str) -> UvicornProc:
    env = os.environ.copy()
    # Ensure backend cwd is import root
    env.setdefault("PYTHONPATH", str(BACKEND_DIR))

    # Windows: create a new process group so CTRL_BREAK works
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

    proc = subprocess.Popen(
        [
            python_exe,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ],
        cwd=str(BACKEND_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=creationflags,
    )

    log_lines: list[str] = []

    def _pump() -> None:
        try:
            if not proc.stdout:
                return
            for line in proc.stdout:
                log_lines.append(line)
        except Exception:
            return

    t = threading.Thread(target=_pump, name="uvicorn-log-pump", daemon=True)
    t.start()
    return UvicornProc(proc=proc, log_lines=log_lines, _log_thread=t)


async def wait_for_health(uv: UvicornProc, timeout_s: float = 30.0) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    last_err: Exception | None = None

    async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
        while time.time() < deadline:
            if uv.proc.poll() is not None:
                raise RuntimeError(
                    "uvicorn exited before /health became ready. Log tail:\n" + uv.tail(200)
                )
            try:
                r = await client.get(f"{BASE_URL}/health")
                if r.status_code == 200:
                    return r.json()
            except Exception as e:
                last_err = e
            await asyncio.sleep(0.5)

    raise RuntimeError(
        f"/health not ready within {timeout_s}s: {last_err}\nuvicorn log tail:\n{uv.tail(200)}"
    )


def find_sample_pptx() -> Path:
    sessions_dir = BACKEND_DIR / "sessions"
    candidates = []
    for child in sessions_dir.iterdir():
        if not child.is_dir():
            continue
        p = child / "presentation.pptx"
        if p.exists():
            candidates.append(p)

    if not candidates:
        raise FileNotFoundError("No existing sessions/*/presentation.pptx found")

    # Prefer smallest for speed
    candidates.sort(key=lambda x: x.stat().st_size)
    return candidates[0]


def ensure_sample_video(tmp_dir: Path) -> Path:
    """Generate a tiny valid MP4 using ffmpeg for upload-mode regression."""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    out = tmp_dir / "smoke_upload.mp4"
    if out.exists() and out.stat().st_size > 1024:
        return out

    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        str(out),
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0 or not out.exists():
        raise RuntimeError(f"ffmpeg failed: {p.stderr or p.stdout}")
    return out


async def ws_collect(
    session_id: str,
    stop_event: asyncio.Event,
    out: list[dict[str, Any]],
    connected_event: asyncio.Event | None = None,
) -> None:
    url = f"{WS_BASE}/ws/sessions/{session_id}"
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
            if connected_event is not None:
                connected_event.set()

            # sanity: ask server to echo a metric so we know the pipe works
            try:
                await ws.send(json.dumps({"type": "metric", "data": {"name": "smoke"}}))
            except Exception as e:
                out.append({"type": "_ws_error", "stage": "send_metric", "error": str(e)})

            # collect until stop
            while not stop_event.is_set():
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                try:
                    out.append(json.loads(msg))
                except Exception:
                    out.append({"type": "_raw", "raw": msg})
    except Exception as e:
        if connected_event is not None:
            connected_event.set()
        out.append({"type": "_ws_error", "stage": "connect_or_recv", "error": str(e)})


async def create_session(client: httpx.AsyncClient, mode: str, title: str, ppt_path: Path | None = None) -> dict[str, Any]:
    data = {"mode": mode, "title": title}
    files = None
    if ppt_path is not None:
        files = {"ppt_file": (ppt_path.name, ppt_path.read_bytes(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")}

    r = await client.post(f"{BASE_URL}/api/sessions", data=data, files=files)
    r.raise_for_status()
    return r.json()


async def upload_text_file(client: httpx.AsyncClient, url: str, filename: str, content: str) -> dict[str, Any]:
    files = {"script": (filename, content.encode("utf-8"), "text/plain; charset=utf-8")}
    r = await client.post(url, files=files)
    r.raise_for_status()
    return r.json()


async def wait_session_status(client: httpx.AsyncClient, session_id: str, target: set[str], timeout_s: float = 180.0) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    last: dict[str, Any] | None = None
    while time.time() < deadline:
        r = await client.get(f"{BASE_URL}/api/sessions/{session_id}")
        r.raise_for_status()
        last = r.json()
        if str(last.get("status")) in target:
            return last
        await asyncio.sleep(1.0)

    raise TimeoutError(f"Session {session_id} not in {target} within {timeout_s}s, last={last and last.get('status')}")


async def export_pdf(client: httpx.AsyncClient, session_id: str) -> bytes:
    r = await client.post(f"{BASE_URL}/api/sessions/{session_id}/export/pdf")
    r.raise_for_status()

    r2 = await client.get(f"{BASE_URL}/api/sessions/{session_id}/export/pdf")
    r2.raise_for_status()
    return r2.content


async def main() -> None:
    python_exe = sys.executable
    uv = start_uvicorn(python_exe)
    try:
        health = await wait_for_health(uv)
        print("health_ok", json.dumps(health, ensure_ascii=False))

        async with httpx.AsyncClient(timeout=120.0, trust_env=False) as client:
            # 1) Script analysis flow
            sess_script = await create_session(client, "script_analysis", "regression-script-analysis")
            sid_script = sess_script["id"]
            script_text = """大家好，今天我来介绍我们项目。\n\n这次分享主要分三点：背景、方案、结果。\n\n最后谢谢大家。"""
            await upload_text_file(client, f"{BASE_URL}/api/sessions/{sid_script}/upload/script", "script.txt", script_text)
            s1 = await wait_session_status(client, sid_script, {"completed", "error"}, timeout_s=120.0)
            print("script_session_status", sid_script, s1.get("status"))
            if str(s1.get("status")) == "error":
                print("uvicorn_log_tail_after_script_error\n" + uv.tail(200))
            r = await client.get(f"{BASE_URL}/api/sessions/{sid_script}/report")
            r.raise_for_status()
            report_payload = r.json()
            report_obj = report_payload.get("report") or {}
            assert isinstance(report_obj, dict), "report is not a dict"
            assert "script_analysis" in report_obj, "script_analysis missing in report.report"

            # 2) PPT analysis flow (+ WS progress)
            pptx = find_sample_pptx()
            sess_ppt = await create_session(client, "ppt_analysis", "regression-ppt-analysis", pptx)
            sid_ppt = sess_ppt["id"]

            ws_msgs: list[dict[str, Any]] = []
            stop_ws = asyncio.Event()
            ws_connected = asyncio.Event()
            ws_task = asyncio.create_task(ws_collect(sid_ppt, stop_ws, ws_msgs, ws_connected))
            # ensure ws task has attempted to connect before analysis completes
            try:
                await asyncio.wait_for(ws_connected.wait(), timeout=10.0)
            except Exception:
                pass

            s2 = await wait_session_status(client, sid_ppt, {"completed", "error"}, timeout_s=300.0)
            stop_ws.set()
            try:
                await asyncio.wait_for(ws_task, timeout=3.0)
            except Exception:
                ws_task.cancel()

            print("ppt_session_status", sid_ppt, s2.get("status"), "ws_msgs", len(ws_msgs))

            # Verify late-join WS hydration: connect after completion and see if server pushes cached progress/state
            cached_msgs: list[dict[str, Any]] = []
            try:
                async with websockets.connect(f"{WS_BASE}/ws/sessions/{sid_ppt}") as ws2:
                    for _ in range(5):
                        try:
                            raw = await asyncio.wait_for(ws2.recv(), timeout=0.8)
                        except asyncio.TimeoutError:
                            break
                        try:
                            cached_msgs.append(json.loads(raw))
                        except Exception:
                            cached_msgs.append({"type": "_raw", "raw": raw})
            except Exception as e:
                cached_msgs.append({"type": "_ws_error", "stage": "late_join", "error": str(e)})

            print("ppt_ws_late_join_msgs", len(cached_msgs), [m.get("type") for m in cached_msgs[:5]])
            has_cached_state = any(
                isinstance(m.get("type"), str)
                and (
                    str(m.get("type")).startswith("ppt_analysis.")
                    or str(m.get("type")).startswith("analysis.")
                    or str(m.get("type")) == "report.ready"
                )
                for m in cached_msgs
            )
            if not has_cached_state:
                print("warn_ws_no_cached_state")

            # Validate slides have analysis payloads (or safe fallback)
            slides = s2.get("slides") or []
            assert len(slides) > 0, "ppt_analysis session has no slides"
            missing = [sl.get("slide_index") for sl in slides if not sl.get("analysis_json") and not sl.get("analysis")]
            if missing:
                raise AssertionError(f"slides missing analysis_json: {missing[:10]}")

            # 3) Upload PPT script + verify persisted
            slide_count = len(slides)
            parts = [f"这是第{i}页逐字稿示例：本页关键点是……" for i in range(1, slide_count + 1)]
            ppt_script = ("\n\n---\n\n").join(parts)
            files = {"script": ("ppt_script.txt", ppt_script.encode("utf-8"), "text/plain; charset=utf-8")}
            ru = await client.post(f"{BASE_URL}/api/sessions/{sid_ppt}/upload/ppt_script", files=files)
            ru.raise_for_status()
            uploaded = ru.json()
            assert uploaded.get("updated_slides", 0) > 0, "ppt_script updated_slides=0"

            s3 = (await client.get(f"{BASE_URL}/api/sessions/{sid_ppt}")).json()
            assert s3.get("ppt_script_path"), "ppt_script_path not persisted"

            # 4) WebSocket page_turn timing attribution sanity
            async with websockets.connect(f"{WS_BASE}/ws/sessions/{sid_ppt}") as ws:
                await ws.send(json.dumps({"type": "page_turn", "slide_index": 1, "time_ms": 0}))
                await ws.send(json.dumps({"type": "page_turn", "slide_index": 2, "time_ms": 5000}))
                await ws.send(json.dumps({"type": "session_end", "slide_index": 2, "time_ms": 12000}))
                await asyncio.sleep(0.5)

            s4 = (await client.get(f"{BASE_URL}/api/sessions/{sid_ppt}")).json()
            slides4 = {int(sl.get("slide_index")): sl for sl in (s4.get("slides") or [])}
            if 1 in slides4:
                assert slides4[1].get("start_ms") in (0, "0") or slides4[1].get("start_ms") == 0
                assert slides4[1].get("end_ms") in (5000, "5000") or slides4[1].get("end_ms") == 5000
            if 2 in slides4:
                assert slides4[2].get("start_ms") in (5000, "5000") or slides4[2].get("start_ms") == 5000
                assert slides4[2].get("end_ms") in (12000, "12000") or slides4[2].get("end_ms") == 12000

            # 5) Export PDF should not be empty
            pdf_bytes = await export_pdf(client, sid_ppt)
            assert len(pdf_bytes) > 1024, f"exported pdf too small: {len(pdf_bytes)} bytes"
            print("export_pdf_ok", len(pdf_bytes))

            # 6) Report payload should include PPT prep storyline when available
            r2 = await client.get(f"{BASE_URL}/api/sessions/{sid_ppt}/report")
            r2.raise_for_status()
            report2 = r2.json()
            # deck_storyline is optional, but for new analysis we expect it.
            report_obj2 = report2.get("report") or {}
            ppt_prep = (report_obj2.get("ppt_prep") if isinstance(report_obj2, dict) else None) or {}
            if isinstance(ppt_prep, dict) and "deck_storyline" not in ppt_prep:
                print("warn_missing_deck_storyline")

            # 7) Upload-mode flow: upload video -> finish -> report -> export
            sample_video = ensure_sample_video(BACKEND_DIR / "tools" / ".tmp")
            sess_up = await create_session(client, "upload", "regression-upload")
            sid_up = sess_up["id"]
            files_up = {"video": (sample_video.name, sample_video.read_bytes(), "video/mp4")}
            ru1 = await client.post(f"{BASE_URL}/api/sessions/{sid_up}/upload/video", files=files_up)
            ru1.raise_for_status()

            rf = await client.post(f"{BASE_URL}/api/sessions/{sid_up}/finish")
            rf.raise_for_status()
            su = await wait_session_status(client, sid_up, {"completed", "error"}, timeout_s=600.0)
            print("upload_session_status", sid_up, su.get("status"))
            r_up = await client.get(f"{BASE_URL}/api/sessions/{sid_up}/report")
            r_up.raise_for_status()
            pdf_up = await export_pdf(client, sid_up)
            assert len(pdf_up) > 1024, f"upload-mode exported pdf too small: {len(pdf_up)} bytes"

        print("ALL_OK")
    finally:
        uv.stop()
        # Always print tail if something went wrong
        if uv.proc.poll() is not None and uv.proc.returncode not in (0, None):
            print("uvicorn_exit_code", uv.proc.returncode)
            print("uvicorn_log_tail\n" + uv.tail(200))


if __name__ == "__main__":
    asyncio.run(main())
