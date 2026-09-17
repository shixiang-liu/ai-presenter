"""实时通信 WebSocket 路由。"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
import json
import time
import re

from ..realtime import manager
from ..services.asr_proxy import BaiduASRProxy
from ..models import database as db

router = APIRouter()

# 每个会话对应的语音识别代理
asr_proxies: dict[str, BaiduASRProxy] = {}

# 记录会话是否已收到真实音频
_asr_audio_seen: dict[str, bool] = {}
_asr_last_audio_ts: dict[str, float] = {}
_asr_keepalive_tasks: dict[str, asyncio.Task] = {}


async def _ensure_asr_keepalive(session_id: str) -> None:
    """在收到第一段真实音频前，周期性发送短静音数据。

    百度 ASR 在 START 后短时间不收音频会主动断开；
    这里用静音保活，避免浏览器音频管线尚未就绪时被提前断连。
    """
    if session_id in _asr_keepalive_tasks and not _asr_keepalive_tasks[session_id].done():
        return

    async def _run():
        start = time.monotonic()
        silence = b"\x00\x00" * 1600  # 100ms @ 16kHz mono s16le
        while True:
            if session_id not in asr_proxies:
                return
            if _asr_audio_seen.get(session_id):
                return
            # 最多尝试 10 秒
            if time.monotonic() - start > 10.0:
                return

            try:
                await asr_proxies[session_id].send_audio(silence)
            except Exception:
                return
            await asyncio.sleep(0.1)

    _asr_keepalive_tasks[session_id] = asyncio.create_task(_run())

@router.websocket("/ws/sessions/{session_id}")
async def session_websocket(websocket: WebSocket, session_id: str):
    """
    实时会话通信 WebSocket 入口
    
    Client -> Server 消息：
    - {"type": "audio", "data": "<base64 PCM>"}  # ASR 音频帧
    - {"type": "event", "data": {...}}  # 前端实时事件（MediaPipe）
    - {"type": "page_turn", "slide_index": 1, "time_ms": 12345}  # PPT 翻页
    
    Server -> Client 消息：
    - {"type": "asr.mid_text", "text": "..."}  # ASR 中间结果
    - {"type": "asr.fin_text", "text": "...", "start_ms": 0, "end_ms": 0}  # ASR 最终结果
    - {"type": "analysis.progress", "progress": 50}  # 分析进度
    - {"type": "report.event", "event": {...}}  # 新事件
    - {"type": "report.ready"}  # 报告已生成
    """
    await manager.connect(session_id, websocket)
    
    # 初始化 ASR 代理
    current_slide_index: int | None = None
    last_fin_end_ms: int | None = None
    asr_time_offset_ms: int = 0
    asr_proxy: BaiduASRProxy | None = None
    audio_chunk_counter: int = 0
    
    try:
        while True:
            data = await websocket.receive()
            
            if data["type"] == "websocket.disconnect":
                break
            
            if "text" in data:
                message = json.loads(data["text"])
                msg_type = message.get("type")
                
                if msg_type == "start_asr":
                    try:
                        print(f"[WS] session={session_id} start_asr 时间偏移={message.get('time_offset_ms', 0)}")
                    except Exception:
                        pass
                    # 可选：应用时间偏移（例如上传模式跳转后继续）
                    asr_time_offset_ms = int(message.get("time_offset_ms", 0) or 0)
                    last_fin_end_ms = None

                    async def on_asr_result(result):
                        try:
                            asr_type = f"asr.{result['type']}"
                            print(f"[WS] 收到识别结果: session={session_id} type={asr_type} text={result.get('text', '')[:30]}")
                            # 构造消息体：先展开结果，再设置类型避免覆盖
                            payload = {**result, "type": asr_type}
                            print(f"[WS] 准备广播 payload type={payload.get('type')}")
                            # 优先用广播推送（同一会话可能有多个连接）
                            await manager.broadcast(session_id, payload)
                            print(f"[WS] 广播完成")
                        except Exception as e:
                            import traceback
                            print(f"[WS] on_asr_result 异常: {e}")
                            traceback.print_exc()

                        # 将最终文本写入数据库
                        if result["type"] == "fin_text" and result.get("text"):
                            nonlocal last_fin_end_ms

                            raw_start_ms = int(result.get("start_ms", 0) or 0)
                            raw_end_ms = int(result.get("end_ms", 0) or 0)

                            # 写库/对齐时应用偏移
                            start_ms = raw_start_ms + asr_time_offset_ms
                            end_ms = raw_end_ms + asr_time_offset_ms

                            # 片段语速（CPM：字/分钟）
                            def _count_spoken_chars(t: str) -> int:
                                # 统计中文/数字/字母（近似表示可读长度）
                                if not t:
                                    return 0
                                t = re.sub(r"\s+", "", t)
                                # 只保留中文/数字/字母
                                kept = re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", t)
                                return len(kept)

                            duration_min = max(1e-6, (raw_end_ms - raw_start_ms) / 1000.0 / 60.0)
                            spoken_chars = _count_spoken_chars(result.get("text", ""))
                            cpm = int(spoken_chars / duration_min) if spoken_chars > 0 else 0
                            if cpm > 240 or cpm < 160:
                                speed_event = {
                                    "type": "issue",
                                    "category": "speed_fast" if cpm > 240 else "speed_slow",
                                    "severity": "medium" if 160 <= cpm <= 260 else "high",
                                    "start_ms": start_ms,
                                    "end_ms": end_ms,
                                    "evidence": {
                                        "cpm": cpm,
                                        "threshold_fast": 240,
                                        "threshold_slow": 160,
                                        "spoken_chars": spoken_chars,
                                        "asr_text": result.get("text", ""),
                                    },
                                }
                                speed_event_id = await db.add_event(
                                    session_id=session_id,
                                    event_type="issue",
                                    category=speed_event["category"],
                                    severity=speed_event["severity"],
                                    start_ms=start_ms,
                                    end_ms=end_ms,
                                    evidence=speed_event["evidence"],
                                    slide_index=current_slide_index,
                                )
                                speed_event["id"] = speed_event_id
                                await manager.send(websocket, {"type": "report.event", "event": speed_event})
                                await manager.broadcast(session_id, {"type": "report.event", "event": speed_event})

                            if last_fin_end_ms is not None:
                                gap = start_ms - last_fin_end_ms
                                if gap >= 5000:
                                    pause_event = {
                                        "type": "issue",
                                        "category": "pause_long",
                                        "severity": "medium" if gap < 8000 else "high",
                                        "start_ms": last_fin_end_ms,
                                        "end_ms": start_ms,
                                        "evidence": {"gap_ms": gap},
                                    }
                                    pause_event_id = await db.add_event(
                                        session_id=session_id,
                                        event_type="issue",
                                        category="pause_long",
                                        severity=pause_event["severity"],
                                        start_ms=pause_event["start_ms"],
                                        end_ms=pause_event["end_ms"],
                                        evidence=pause_event["evidence"],
                                        slide_index=current_slide_index,
                                    )
                                    pause_event["id"] = pause_event_id
                                    await manager.broadcast(session_id, {"type": "report.event", "event": pause_event})

                            last_fin_end_ms = end_ms

                            await db.add_transcript_segment(
                                session_id=session_id,
                                start_ms=start_ms,
                                end_ms=end_ms,
                                text=result["text"],
                                slide_index=current_slide_index,
                            )

                            # 检测口头禅
                            await check_filler_words(
                                websocket,
                                session_id,
                                result,
                                current_slide_index,
                                asr_time_offset_ms,
                            )

                    async def on_asr_error(error):
                        try:
                            payload = {"type": "asr.error", "error": error}
                            await manager.broadcast(session_id, payload)
                        except Exception:
                            pass

                    # 若未启动则创建并连接
                    if session_id not in asr_proxies:
                        asr_proxy = BaiduASRProxy(on_asr_result, on_asr_error)
                        connected = await asr_proxy.connect()
                        if connected:
                            asr_proxies[session_id] = asr_proxy
                            _asr_audio_seen[session_id] = False
                            _asr_last_audio_ts[session_id] = time.monotonic()
                            await _ensure_asr_keepalive(session_id)
                            started_msg = {"type": "asr.started"}
                            await manager.broadcast(session_id, started_msg)
                            try:
                                await manager.send(websocket, started_msg)
                            except Exception:
                                pass
                        else:
                            err_msg = {"type": "asr.error", "error": "Failed to connect to ASR"}
                            await manager.broadcast(session_id, err_msg)
                            try:
                                await manager.send(websocket, err_msg)
                            except Exception:
                                pass
                    else:
                        # 已在运行：仅确认（偏移在入库时生效）
                        _asr_audio_seen.setdefault(session_id, False)
                        _asr_last_audio_ts.setdefault(session_id, time.monotonic())
                        await _ensure_asr_keepalive(session_id)
                        started_msg = {"type": "asr.started"}
                        await manager.broadcast(session_id, started_msg)
                        try:
                            await manager.send(websocket, started_msg)
                        except Exception:
                            pass
                
                elif msg_type == "stop_asr":
                    try:
                        print(f"[WS] session={session_id} stop_asr")
                    except Exception:
                        pass
                    # 停止 ASR 代理
                    if session_id in asr_proxies:
                        await asr_proxies[session_id].finish()
                        del asr_proxies[session_id]
                        _asr_audio_seen.pop(session_id, None)
                        _asr_last_audio_ts.pop(session_id, None)
                        task = _asr_keepalive_tasks.pop(session_id, None)
                        if task and not task.done():
                            task.cancel()
                        stopped_msg = {"type": "asr.stopped"}
                        await manager.broadcast(session_id, stopped_msg)
                        try:
                            await manager.send(websocket, stopped_msg)
                        except Exception:
                            pass
                
                elif msg_type == "page_turn":
                    # 记录翻页
                    current_slide_index = int(message.get("slide_index", 0) or 0)
                    time_ms = message.get("time_ms", 0)
                    
                    # 更新数据库中的页时间
                    if current_slide_index > 0:
                        await db.update_slide(session_id, current_slide_index, start_ms=time_ms)
                    
                    # 更新上一页结束时间
                    if current_slide_index > 1:
                        await db.update_slide(session_id, current_slide_index - 1, end_ms=time_ms)

                elif msg_type == "session_end":
                    # 练习结束时补齐当前页结束时间
                    try:
                        time_ms = int(message.get("time_ms", 0) or 0)
                        slide_index = message.get("slide_index")
                        if slide_index is not None:
                            current_slide_index = int(slide_index)
                        if current_slide_index and current_slide_index > 0:
                            await db.update_slide(session_id, current_slide_index, end_ms=time_ms)
                    except Exception:
                        pass
                
                elif msg_type == "event":
                    # 保存前端事件（MediaPipe 检测）
                    event_data = message.get("data", {})
                    event_id = await db.add_event(
                        session_id=session_id,
                        event_type=event_data.get("type", "issue"),
                        category=event_data.get("category", "unknown"),
                        severity=event_data.get("severity", "low"),
                        start_ms=event_data.get("start_ms", 0),
                        end_ms=event_data.get("end_ms", 0),
                        evidence=event_data.get("evidence", {}),
                        slide_index=current_slide_index
                    )

                    try:
                        event_data["id"] = event_id
                    except Exception:
                        pass
                    
                    # 向该会话所有连接广播
                    await manager.broadcast(session_id, {"type": "report.event", "event": event_data})
                
                elif msg_type == "metric":
                    # HUD 实时指标更新
                    await manager.send(websocket, {"type": "realtime.metric", **message.get("data", {})})
            
            elif "bytes" in data:
                # 二进制音频数据
                audio_chunk_counter += 1
                _asr_audio_seen[session_id] = True
                _asr_last_audio_ts[session_id] = time.monotonic()
                if audio_chunk_counter == 1 or audio_chunk_counter % 10 == 0:
                    try:
                        print(f"[WS] session={session_id} received audio chunks={audio_chunk_counter} size={len(data['bytes'])}")
                    except Exception:
                        pass
                if session_id in asr_proxies:
                    await asr_proxies[session_id].send_audio(data["bytes"])
                else:
                    # 若未收到启动指令就开始送音频，则尝试懒启动
                    try:
                        async def _noop_result(_):
                            return

                        async def _noop_error(_):
                            return

                        asr_proxy = BaiduASRProxy(_noop_result, _noop_error)
                        connected = await asr_proxy.connect()
                        if connected:
                            asr_proxies[session_id] = asr_proxy
                            _asr_audio_seen[session_id] = True
                            _asr_last_audio_ts[session_id] = time.monotonic()
                            await asr_proxies[session_id].send_audio(data["bytes"])
                    except Exception:
                        pass
                    
    except WebSocketDisconnect:
        pass
    except Exception as e:
        import traceback
        print(f"WebSocket error: {repr(e)}")
        traceback.print_exc()
    finally:
        # 清理连接
        await manager.disconnect(session_id, websocket)

        # 仅在该会话无剩余连接时关闭 ASR
        try:
            remaining = await manager.connection_count(session_id)
        except Exception:
            remaining = 0

        if remaining == 0 and session_id in asr_proxies:
            await asr_proxies[session_id].close()
            del asr_proxies[session_id]

        if remaining == 0:
            _asr_audio_seen.pop(session_id, None)
            _asr_last_audio_ts.pop(session_id, None)
            task = _asr_keepalive_tasks.pop(session_id, None)
            if task and not task.done():
                task.cancel()

# 口头禅词表
# 默认取保守值，减少误报。
# “这个”等词在中文里常有语义，默认不算口头禅。
FILLER_WORDS_ZH = [
    "嗯", "啊", "呃", "额",
    "那个", "那什么", "怎么说", "就是说",
    "对吧",
    "然后", "然后呢",
]

FILLER_WORDS_EN = [
    "so", "like", "you know", "um", "uh", "well",
]

_PUNCT = set(list("，,。.!?！？；;：:、\n\t \"'（）()[]{}<>"))

def _find_filler_hits(text: str) -> list[str]:
    """基于粗略边界的口头禅启发式检测。

    仅当词出现在片段开头/结尾，或紧邻标点/空白时才计入，
    用于过滤大量误报（例如“这个算法”不应被判为口头禅）。
    """
    if not text:
        return []
    raw = text.strip()
    lower = raw.lower()

    hits: list[str] = []

    # 英文：依赖单词边界
    for tok in FILLER_WORDS_EN:
        try:
            if re.search(rf"\b{re.escape(tok)}\b", lower):
                hits.append(tok)
        except Exception:
            continue

    # 中文：靠近标点/位于开头
    for tok in FILLER_WORDS_ZH:
        start = 0
        while True:
            idx = raw.find(tok, start)
            if idx < 0:
                break
            prev = raw[idx - 1] if idx > 0 else ""
            nxt_i = idx + len(tok)
            nxt = raw[nxt_i] if nxt_i < len(raw) else ""

            prev_ok = (idx == 0) or (prev in _PUNCT)
            next_ok = (nxt_i >= len(raw)) or (nxt in _PUNCT)
            if prev_ok or next_ok:
                hits.append(tok)
            start = idx + len(tok)

    # 去重但保持顺序
    seen = set()
    out = []
    for h in hits:
        if h in seen:
            continue
        seen.add(h)
        out.append(h)
    return out

async def check_filler_words(
    websocket: WebSocket,
    session_id: str,
    asr_result: dict,
    slide_index: int | None,
    time_offset_ms: int = 0,
):
    """检测 ASR 结果中的口头禅"""
    text = asr_result.get("text", "")
    hits = _find_filler_hits(text)
    
    if hits:
        raw_start_ms = int(asr_result.get("start_ms", 0) or 0)
        raw_end_ms = int(asr_result.get("end_ms", 0) or 0)
        start_ms = raw_start_ms + int(time_offset_ms or 0)
        end_ms = raw_end_ms + int(time_offset_ms or 0)

        event = {
            "type": "issue",
            "category": "filler_word",
            "severity": "medium" if len(hits) > 1 else "low",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "evidence": {
                "asr_text": asr_result.get("text", ""),
                "hits": hits,
                "count": len(hits)
            }
        }
        
        # 写入数据库
        event_id = await db.add_event(
            session_id=session_id,
            event_type="issue",
            category="filler_word",
            severity=event["severity"],
            start_ms=event["start_ms"],
            end_ms=event["end_ms"],
            evidence=event["evidence"],
            slide_index=slide_index
        )
        event["id"] = event_id
        
        # 推送到前端
        await manager.send(websocket, {"type": "report.event", "event": event})
        await manager.broadcast(session_id, {"type": "report.event", "event": event})
