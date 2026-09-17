"""
Session API Routes
"""
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any
import asyncio
import shutil
import json
import os

from ..models import database as db
from ..services import ppt_parser, glm_analyzer, audio_analyzer
from ..services.pdf_exporter import generate_session_pdf
from ..realtime import manager
from ..config import settings

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _read_script_file(file_path: Path) -> str:
    """
    Read script file and return text content.
    Supports: .txt, .md, .doc, .docx
    """
    suffix = file_path.suffix.lower()
    
    if suffix in (".doc", ".docx"):
        try:
            from docx import Document
            doc = Document(str(file_path))
            # Extract all paragraph text
            paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
            return "\n\n".join(paragraphs)
        except Exception as e:
            print(f"Failed to parse Word document: {e}")
            return ""

    # Plain text files (.txt, .md, etc.)
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        # Try other encodings
        for enc in ["gbk", "gb2312", "latin-1"]:
            try:
                return file_path.read_text(encoding=enc)
            except UnicodeDecodeError:
                continue
        return ""
    except Exception as e:
        print(f"Failed to read script file: {e}")
        return ""


def _split_ppt_script_into_slides(text: str, slide_count: int) -> Dict[int, str]:
    """Split a user-provided script into per-slide text.

    Supported formats (recommended):
    1) Use a separator line `---` between slides (N blocks => slides 1..N).
    2) Use headings like `# Slide 1` / `## 第1页` / `### 1` to mark slide starts.

    Returns a mapping: {slide_index(1-based): script_text}
    """
    if not text:
        return {}

    raw = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return {}

    import re

    # 1) Explicit slide markers by heading
    heading_re = re.compile(
        r"^\s*#{1,6}\s*(?:Slide\s*(\d+)|第\s*(\d+)\s*页|(\d+))\s*(?:[:：].*)?$",
        re.IGNORECASE | re.MULTILINE,
    )

    matches = list(heading_re.finditer(raw))
    if matches:
        chunks: Dict[int, str] = {}
        for i, m in enumerate(matches):
            idx_str = m.group(1) or m.group(2) or m.group(3)
            try:
                slide_idx = int(idx_str)
            except Exception:
                continue

            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
            chunk = raw[start:end].strip()
            if chunk:
                chunks[slide_idx] = chunk

        # Clamp to existing slide count
        return {k: v for k, v in chunks.items() if 1 <= int(k) <= int(slide_count or 0)}

    # 2) Separator line `---`
    sep_re = re.compile(r"^\s*---\s*$", re.MULTILINE)
    if sep_re.search(raw):
        parts = [p.strip() for p in sep_re.split(raw)]
        parts = [p for p in parts if p]
        mapping: Dict[int, str] = {}
        for i, p in enumerate(parts[: max(0, int(slide_count or 0))], 1):
            mapping[i] = p
        return mapping

    # 3) Fallback: single block -> slide 1
    return {1: raw}

def generate_session_id() -> str:
    """Generate unique session ID"""
    return datetime.now().strftime("%Y%m%d-%H%M%S")

def get_session_dir(session_id: str) -> Path:
    """Get session directory path"""
    return settings.SESSIONS_DIR / session_id

@router.post("")
async def create_session(
    background_tasks: BackgroundTasks,
    mode: str = Form(...),
    title: Optional[str] = Form(None),
    ppt_file: Optional[UploadFile] = File(None)
):
    """
    Create a new practice session
    
    Modes:
    - ppt: PPT presentation mode (requires ppt_file)
    - ppt_analysis: PPT prep-only analysis (requires ppt_file; no recording)
    - script: Script mode
    - script_analysis: Script analysis only (no recording)
    - free: Free speech mode
    - upload: Video upload analysis mode
    """
    session_id = generate_session_id()
    session_dir = get_session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    
    ppt_path = None
    slides_info = []
    
    # Handle PPT upload (ppt / ppt_analysis)
    if mode in ("ppt", "ppt_analysis") and ppt_file:
        # Save uploaded file
        ppt_ext = Path(ppt_file.filename).suffix
        ppt_path = session_dir / f"presentation{ppt_ext}"
        
        with open(ppt_path, "wb") as f:
            content = await ppt_file.read()
            f.write(content)
        
        # 判断是否需要转换图片
        # PPT/PPTX 格式直接转图片（更稳定）
        # PDF 格式跳过图片转换，使用 GLM 直接分析
        suffix = ppt_path.suffix.lower()
        need_images = (mode == "ppt") or (suffix in ('.ppt', '.pptx'))
        
        if need_images:
            # Parse PPT/PPTX to images
            slides_dir = session_dir / "slides"
            slides_info = await ppt_parser.parse_ppt_to_images(str(ppt_path), str(slides_dir))
            
            # Prepare slides data for DB
            for slide in slides_info:
                await db.add_slide(
                    session_id=session_id,
                    slide_index=slide["index"],
                    image_path=slide["image_path"],
                    notes=slide.get("notes", ""),
                    generated_script=""
                )
        else:
            # PDF in ppt_analysis mode: 跳过图片转换，后面使用 GLM 直接分析
            try:
                slide_count = await ppt_parser.get_slide_count(str(ppt_path))
            except Exception:
                slide_count = 0
            
            slides_info = [{"index": i + 1, "image_path": None, "notes": ""} for i in range(max(1, slide_count))]
            
            for slide in slides_info:
                await db.add_slide(
                    session_id=session_id,
                    slide_index=slide["index"],
                    image_path="",
                    notes="",
                    generated_script=""
                )

        # For PPT Practice Mode: Run analysis in BACKGROUND so user can start immediately
        if mode == "ppt":
            async def _analyze_slides_bg(slides, sess_id):
                tasks = []
                total = len(slides) if slides else 0
                for s in slides:
                    tasks.append(
                        glm_analyzer.analyze_slide_content(
                            s["image_path"],
                            slide_index=int(s.get("index") or 0) or None,
                            total_slides=total or None,
                        )
                    )
                
                results = await asyncio.gather(*tasks, return_exceptions=True)
                
                for i, res in enumerate(results):
                    if not isinstance(res, Exception):
                        # Store AI analysis without overwriting any user-provided transcript.
                        await db.update_slide(
                            session_id=sess_id,
                            slide_index=slides[i]["index"],
                            analysis=res,
                        )
            
            background_tasks.add_task(_analyze_slides_bg, slides_info, session_id)
    
    session = await db.create_session(
        session_id=session_id,
        mode=mode,
        title=title or f"练习 {session_id}",
        ppt_path=str(ppt_path) if ppt_path else None
    )
    
    # Update with slides count
    if slides_info:
        await db.update_session(session_id, slides_count=len(slides_info))

    # PPT analysis mode: run in BACKGROUND and return immediately
    # User will see progress in Review page via WebSocket
    if mode == "ppt_analysis" and slides_info:
        await db.update_session(session_id, status="analyzing")
        
        async def _run_ppt_analysis_bg(sess_id: str, slides: List[Dict[str, Any]], sess_dir: Path):
            """Background task for PPT analysis - sends progress via WebSocket
            
            优先尝试使用 GLM-4.6V-Flash 的原生文件理解能力（对PDF文件），
            一次性分析整个文档。如果失败或者是PPTX文件，则回退到逐页图片分析。
            """
            try:
                total_slides = len(slides)
                session_data = await db.get_session(sess_id)
                ppt_path = session_data.get("ppt_path") if session_data else None
                
                # 检查是否可以使用直接文件分析
                # 检查是否可以使用直接文件分析
                # 只有 PDF 才尝试直接分析（PPT/PPTX 文件太大容易 Prompt 超长，直接用 Office 转图片更稳定）
                use_direct_analysis = False
                if ppt_path:
                    suffix = Path(ppt_path).suffix.lower()
                    # 只有 PDF 才尝试直接分析
                    if suffix == '.pdf':
                        use_direct_analysis = True
                
                prep_report = None
                
                # Stage 1: 尝试直接文件分析（仅PDF）
                if use_direct_analysis and ppt_path:
                    await manager.broadcast(sess_id, {
                        "type": "ppt_analysis.progress", 
                        "progress": 10, 
                        "stage": "direct_analysis",
                        "message": "正在使用 AI 直接理解文档..."
                    })
                    
                    try:
                        direct_result = await glm_analyzer.analyze_document_directly(
                            ppt_path,
                            page_count=total_slides
                        )
                        
                        if "error" not in direct_result and direct_result.get("slides"):
                            # 直接分析成功！更新每页的分析结果
                            await manager.broadcast(sess_id, {
                                "type": "ppt_analysis.progress", 
                                "progress": 60, 
                                "stage": "processing_results",
                                "message": "AI 已理解全文，正在整理每页内容..."
                            })
                            
                            for slide_analysis in direct_result.get("slides", []):
                                slide_index = slide_analysis.get("slide_index")
                                if slide_index and 1 <= slide_index <= total_slides:
                                    # 找到对应的slide并更新
                                    for s in slides:
                                        if s.get("index") == slide_index:
                                            s["analysis"] = slide_analysis
                                            await db.update_slide(
                                                session_id=sess_id,
                                                slide_index=slide_index,
                                                analysis=slide_analysis
                                            )
                                            await manager.broadcast(sess_id, {
                                                "type": "ppt_analysis.slide_completed",
                                                "slide_index": slide_index,
                                                "result": slide_analysis
                                            })
                                            break
                            
                            # 从直接分析结果构建 prep_report
                            prep_report = {
                                "outline": direct_result.get("slides", []),
                                "full_script": direct_result.get("full_script", ""),
                                "deck_storyline": direct_result.get("deck_storyline", ""),
                                "suggestions": direct_result.get("suggestions", []),
                                "overall_structure": direct_result.get("overall_structure", ""),
                                "scores": direct_result.get("scores", {"total": 70, "structure": 70, "logic": 70, "content": 70}),
                                "improvement_areas": [],
                                "estimated_total_duration_sec": sum(
                                    s.get("estimated_duration_sec", 60) for s in direct_result.get("slides", [])
                                )
                            }
                            print(f"Direct document analysis succeeded for {total_slides} slides")
                    except Exception as e:
                        print(f"Direct document analysis failed, falling back to per-slide: {e}")
                        use_direct_analysis = False
                
                # Stage 1 Fallback: 逐页图片分析
                if not prep_report:
                    # 如果之前没有生成图片（ppt_analysis模式跳过了），现在需要生成
                    has_images = any(s.get("image_path") for s in slides)
                    if not has_images and ppt_path:
                        await manager.broadcast(sess_id, {
                            "type": "ppt_analysis.progress", 
                            "progress": 8, 
                            "stage": "converting_slides",
                            "message": "正在转换 PPT 为图片..."
                        })
                        
                        try:
                            slides_dir = sess_dir / "slides"
                            converted_slides = await ppt_parser.parse_ppt_to_images(str(ppt_path), str(slides_dir))
                            
                            # 更新 slides 列表
                            for conv in converted_slides:
                                idx = conv.get("index")
                                for s in slides:
                                    if s.get("index") == idx:
                                        s["image_path"] = conv.get("image_path")
                                        s["notes"] = conv.get("notes", "")
                                        # 更新数据库
                                        await db.update_slide(
                                            session_id=sess_id,
                                            slide_index=idx,
                                            image_path=conv.get("image_path", "")
                                        )
                                        break
                            
                            total_slides = len(slides)
                            print(f"Converted {len(converted_slides)} slides to images")
                        except Exception as conv_e:
                            print(f"Image conversion failed: {conv_e}")
                    
                    await manager.broadcast(sess_id, {
                        "type": "ppt_analysis.progress", 
                        "progress": 5, 
                        "stage": "analyzing_slides",
                        "message": f"正在分析 PPT 页面 (0/{total_slides})"
                    })
                    
                    previous_context = ""
                    
                    for i, slide in enumerate(slides):
                        progress = 5 + int((i + 1) / total_slides * 65)
                        
                        # Notify start of this slide
                        await manager.broadcast(sess_id, {
                            "type": "ppt_analysis.progress", 
                            "progress": progress, 
                            "stage": "analyzing_slides",
                            "message": f"正在深度分析第 {i + 1} 页 ({i + 1}/{total_slides})..."
                        })
                        
                        try:
                            # Serial analysis with context
                            analysis_result = await glm_analyzer.analyze_slide_content(
                                slide["image_path"],
                                previous_context=previous_context,
                                slide_index=int(slide.get("index") or 0) or None,
                                total_slides=int(total_slides) or None,
                            )
                            
                            # Update context for next slide
                            previous_context = analysis_result.get("summary_for_next_slide", "")
                            
                            # Save result (both script and full analysis JSON)
                            slide["analysis"] = analysis_result
                            await db.update_slide(
                                session_id=sess_id, 
                                slide_index=slide["index"], 
                                analysis=analysis_result  # Save full analysis for hydration
                            )
                            
                            # Broadcast completion of THIS slide for real-time frontend update
                            analysis_result["slide_index"] = slide["index"]
                            await manager.broadcast(sess_id, {
                                "type": "ppt_analysis.slide_completed",
                                "slide_index": slide["index"],
                                "result": analysis_result
                            })
                            
                        except Exception as e:
                            print(f"Slide {slide['index']} analysis failed: {e}")
                            # On error, continue with a safe fallback payload so UI/export won't be empty.
                            previous_context = ""  # Reset context on error

                            fallback = {
                                "title": "暂未识别本页标题",
                                "page_type": "content",
                                "key_points": [],
                                "suggested_script": "（本页AI解析失败）建议按'一句话结论 + 2-3个要点 + 下一页引子'的结构讲述，并优先参考PPT备注。",
                                "speaking_tips": "讲到关键名词/数字时放慢语速并停顿 0.5-1 秒；用手势指向屏幕对应位置。",
                                "transition_hint": "先用一句话收束本页结论，再自然引出下一页。",
                                "interaction_points": [],
                                "estimated_duration_sec": 60,
                                "summary_for_next_slide": "",
                                "slide_index": slide.get("index"),
                            }

                            try:
                                slide["analysis"] = fallback
                                await db.update_slide(
                                    session_id=sess_id,
                                    slide_index=slide["index"],
                                    analysis=fallback,
                                )
                            except Exception:
                                pass

                            try:
                                await manager.broadcast(sess_id, {
                                    "type": "ppt_analysis.slide_completed",
                                    "slide_index": slide["index"],
                                    "result": fallback,
                                })
                            except Exception:
                                pass
                
                # Stage 2: Generate prep report (70-95%)
                if not prep_report:
                    await manager.broadcast(sess_id, {
                        "type": "ppt_analysis.progress", 
                        "progress": 75, 
                        "stage": "generating_report",
                        "message": "正在生成备稿建议..."
                    })
                    
                    try:
                        prep_report = await glm_analyzer.generate_ppt_prep_report(slides)
                        print(f"PPT prep report generated: {len(prep_report.get('suggestions', []))} suggestions")
                    except Exception as e:
                        print(f"PPT prep report generation failed: {e}")
                        # Build a minimal non-empty outline from per-slide analysis so UI/export won't be blank.
                        outline = []
                        est_total = 0
                        for s in slides or []:
                            idx = s.get("index")
                            a = (s.get("analysis") or {}) if isinstance(s, dict) else {}
                            title = (a.get("title") or "") if isinstance(a, dict) else ""
                            kps = (a.get("key_points") or []) if isinstance(a, dict) else []
                            if not isinstance(kps, list):
                                kps = []
                            kps = [str(x).strip() for x in kps if str(x).strip()]
                            suggested_script = (a.get("suggested_script") or "") if isinstance(a, dict) else ""
                            speaking_tips = (a.get("speaking_tips") or "") if isinstance(a, dict) else ""
                            transition_hint = (a.get("transition_hint") or "") if isinstance(a, dict) else ""
                            est = int((a.get("estimated_duration_sec") or 0)) if isinstance(a, dict) else 0
                            est_total += max(0, est)
                            outline.append({
                                "slide_index": idx,
                                "title": str(title).strip() or "页面要点",
                                "key_points": kps[:5],
                                "speaking_tips": str(speaking_tips).strip() or "读到关键数字时放慢语速并停顿 0.5-1 秒；用手势指向屏幕对应位置。",
                                "transition_hint": str(transition_hint).strip() or "收束本页结论后，抛出一个承接问题自然带到下一页。",
                                "interaction_points": [],
                                "suggested_script": str(suggested_script).strip() or "这一页先讲清核心结论，再用 2-3 个要点支撑，最后用一句话引向下一页。",
                                "estimated_duration_sec": est or None,
                            })

                        prep_report = {
                            "outline": outline,
                            "suggestions": [
                                "为每页之间准备一句过渡语，确保逻辑连贯。",
                                "开场先交代听众收益与结构，再进入正文。",
                                "结尾总结 3 个要点并给出明确的下一步/行动号召。",
                            ],
                            "scores": {"total": 0, "structure": 0, "logic": 0, "content": 0},
                            "improvement_areas": ["若分析失败请重试"],
                            "overall_structure": "本次未能生成完整的整套备稿报告，已展示逐页要点与基础讲解建议。建议稍后重试以获得更完整的整体结构与主线。",
                            "deck_storyline": "从问题出发，给出方案与证据，最后总结并提出下一步。",
                            "estimated_total_duration_sec": est_total or None,
                        }
                
                # Stage 3: Save report (95-100%)
                await manager.broadcast(sess_id, {
                    "type": "ppt_analysis.progress", 
                    "progress": 95, 
                    "stage": "saving",
                    "message": "正在保存分析结果..."
                })
                
                analysis_dir = sess_dir / "analysis"
                analysis_dir.mkdir(exist_ok=True)
                with open(analysis_dir / "report.json", "w", encoding="utf-8") as f:
                    json.dump({"ppt_prep": prep_report}, f, ensure_ascii=False, indent=2)
                
                await db.update_session(sess_id, status="completed")
                
                await manager.broadcast(sess_id, {
                    "type": "ppt_analysis.progress", 
                    "progress": 100, 
                    "stage": "done",
                    "message": "分析完成！"
                })
                await manager.broadcast(sess_id, {"type": "report.ready"})
                
            except Exception as e:
                print(f"PPT analysis failed for session {sess_id}: {e}")
                await db.update_session(sess_id, status="error")
                await manager.broadcast(sess_id, {
                    "type": "ppt_analysis.progress", 
                    "progress": -1, 
                    "stage": "error",
                    "message": f"分析失败: {str(e)}"
                })
        
        background_tasks.add_task(_run_ppt_analysis_bg, session_id, slides_info, session_dir)
    
    return {
        **session,
        "slides": slides_info,
        "session_dir": str(session_dir)
    }

@router.get("")
async def list_sessions(limit: int = 50, offset: int = 0):
    """List all sessions"""
    sessions = await db.list_sessions(limit=limit, offset=offset)
    return {"sessions": sessions, "total": len(sessions)}

@router.get("/{session_id}")
async def get_session(session_id: str):
    """Get session details"""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Get related data
    slides = await db.get_slides(session_id)
    events = await db.get_events(session_id)
    segments = await db.get_transcript_segments(session_id)

    # Load script text for script mode
    script_text: str | None = None
    script_path = session.get("script_path")
    if script_path:
        try:
            p = Path(str(script_path))
            if p.exists():
                script_text = _read_script_file(p)
        except Exception:
            script_text = None
    
    return {
        **session,
        "slides": slides,
        "events": events,
        "transcript_segments": segments,
        "script_text": script_text,
    }


@router.post("/{session_id}/upload/script")
async def upload_script(session_id: str, script: UploadFile = File(...)):
    """Upload a script file (TXT/Markdown/Word) for script mode."""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session_dir = get_session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(script.filename or "script.txt").suffix.lower() or ".txt"
    script_path = session_dir / f"script{ext}"

    content = await script.read()
    try:
        script_path.write_bytes(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save script: {e}")

    await db.update_session(session_id, script_path=str(script_path))
    
    # If script_analysis mode, run analysis immediately
    if session.get("mode") == "script_analysis":
        try:
            script_text = _read_script_file(script_path)
            if script_text:
                analysis_result = await glm_analyzer.generate_script_analysis(script_text)
                
                # Save analysis report
                analysis_dir = session_dir / "analysis"
                analysis_dir.mkdir(exist_ok=True)
                with open(analysis_dir / "report.json", "w", encoding="utf-8") as f:
                    json.dump({"script_analysis": analysis_result}, f, ensure_ascii=False, indent=2)
                
                await db.update_session(session_id, status="completed")
        except Exception as e:
            print(f"Script analysis failed: {e}")
            await db.update_session(session_id, status="error")
    
    return {"status": "uploaded", "path": str(script_path)}


@router.post("/{session_id}/upload/ppt_script")
async def upload_ppt_script(session_id: str, script: UploadFile = File(...)):
    """Upload a per-slide script file for PPT mode and bind it to slides.

    This enables users to provide their own transcript (逐字稿) aligned to PPT pages.
    """
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.get("mode") not in ("ppt", "ppt_analysis"):
        raise HTTPException(status_code=400, detail="ppt_script is only supported for ppt/ppt_analysis mode")

    session_dir = get_session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(script.filename or "ppt_script.txt").suffix.lower() or ".txt"
    script_path = session_dir / f"ppt_script{ext}"

    content = await script.read()
    try:
        script_path.write_bytes(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save script: {e}")

    # Mark session has user-provided PPT transcript
    try:
        await db.update_session(session_id, ppt_script_path=str(script_path))
    except Exception:
        pass

    # Determine slide count
    slides = await db.get_slides(session_id)
    slide_count = len(slides)
    if slide_count <= 0:
        raise HTTPException(status_code=400, detail="No slides found for this session")

    script_text = _read_script_file(script_path)
    if not script_text.strip():
        raise HTTPException(status_code=400, detail="Empty script content")

    mapping = _split_ppt_script_into_slides(script_text, slide_count)
    if not mapping:
        raise HTTPException(status_code=400, detail="Failed to parse script into slides")

    updated = 0
    for slide_index, slide_script in mapping.items():
        await db.update_slide(session_id=session_id, slide_index=int(slide_index), generated_script=slide_script)
        updated += 1

    return {
        "status": "uploaded",
        "path": str(script_path),
        "slide_count": slide_count,
        "updated_slides": updated,
        "format_hint": "推荐格式：每页之间用一行 --- 分隔；或用标题 '# Slide 1' / '## 第1页' 标记每页。",
    }

@router.post("/{session_id}/finish")
async def finish_session(session_id: str, background_tasks: BackgroundTasks):
    """
    Finish session and trigger analysis
    """
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    await db.update_session(session_id, status="analyzing")
    
    # Run analysis in background
    background_tasks.add_task(run_post_analysis, session_id)
    
    return {"status": "analyzing", "message": "Analysis started"}

async def run_post_analysis(session_id: str):
    """Run post-session analysis (background task)"""
    session_dir = get_session_dir(session_id)
    session = await db.get_session(session_id)
    video_path = Path(session.get("video_path") or (session_dir / "video.webm"))
    audio_path = session_dir / "audio.wav"
    frames_dir = session_dir / "frames"
    
    try:
        await manager.broadcast(session_id, {"type": "analysis.progress", "progress": 5, "stage": "start"})
        
        # Extract audio from video
        audio_extraction_success = False
        if video_path.exists():
            print(f"[Analysis] Extracting audio from {video_path} to {audio_path}")
            await manager.broadcast(session_id, {"type": "analysis.progress", "progress": 15, "stage": "extract_audio"})
            audio_extraction_success = await audio_analyzer.extract_audio_from_video(str(video_path), str(audio_path))
            if audio_extraction_success:
                print(f"[Analysis] Audio extraction successful, file exists: {audio_path.exists()}")
            else:
                print(f"[Analysis] Audio extraction returned False")
        else:
            print(f"[Analysis] Video path does not exist: {video_path}")
        
        # Analyze audio features
        audio_features = {}
        if audio_path.exists():
            print(f"[Analysis] Analyzing audio features from {audio_path}")
            await manager.broadcast(session_id, {"type": "analysis.progress", "progress": 30, "stage": "audio_features"})
            audio_features = await audio_analyzer.analyze_audio_features(str(audio_path))
            if audio_features.get("error"):
                print(f"[Analysis] Audio analysis error: {audio_features.get('error')}")
            else:
                print(f"[Analysis] Audio analysis complete, duration: {audio_features.get('duration_sec')}s")
        else:
            print(f"[Analysis] Audio file not found at {audio_path} (extraction success: {audio_extraction_success})")
        
        # Save metrics series (only if we have audio features)
        if audio_features and not audio_features.get("error"):
            if "f0_curve" in audio_features:
                await db.add_metrics_series(session_id, "f0_curve", audio_features["f0_curve"])
            if "energy_curve" in audio_features:
                await db.add_metrics_series(session_id, "energy_curve", audio_features["energy_curve"])
            if "emotion_curve" in audio_features:
                await db.add_metrics_series(session_id, "emotion_curve", audio_features["emotion_curve"])
        
        # Extract and analyze keyframes
        duration_sec = float(audio_features.get("duration_sec", 0) or 0)
        if duration_sec <= 0:
            # Fallback duration from transcript segments
            segments = await db.get_transcript_segments(session_id)
            if segments:
                duration_sec = max(0.0, (segments[-1].get("end_ms", 0) or 0) / 1000.0)
            # If still 0, let audio_analyzer extract from video file directly
            # (no more hardcoded 300s fallback)

        await manager.broadcast(session_id, {"type": "analysis.progress", "progress": 45, "stage": "extract_frames"})
        keyframes = await audio_analyzer.extract_keyframes(
            str(video_path), 
            str(frames_dir),
            duration_sec=duration_sec
        )
        
        # Analyze each keyframe with GLM
        glm_results = []
        seen_glm_notes: set[str] = set()
        max_glm_highlights = 30
        max_glm_issues = 30
        glm_highlight_count = 0
        glm_issue_count = 0
        total_frames = max(1, len(keyframes))
        for idx, frame in enumerate(keyframes):
            try:
                await manager.broadcast(
                    session_id,
                    {"type": "analysis.progress", "progress": 45 + int((idx + 1) / total_frames * 25), "stage": "glm_frames"},
                )
                # Add timeout protection for GLM calls (30s max per frame)
                try:
                    result = await asyncio.wait_for(
                        glm_analyzer.analyze_speaker_frame(frame["path"]),
                        timeout=30.0
                    )
                except asyncio.TimeoutError:
                    print(f"[Analysis] GLM timeout for frame at {frame['time_ms']}ms, skipping")
                    continue
                    
                result["time_ms"] = frame["time_ms"]
                glm_results.append(result)
                
                # Create highlight/issue events from GLM analysis (dedup + cap)
                conf = float(result.get("confidence_score", 50) or 50)

                issues = result.get("issues") or []
                if isinstance(issues, list) and issues and glm_issue_count < max_glm_issues:
                    issue = str(issues[0] or "").strip()
                    key = f"issue::{issue.lower()}"
                    if issue and key not in seen_glm_notes:
                        seen_glm_notes.add(key)
                        glm_issue_count += 1
                        event_payload = {
                            "type": "issue",
                            "category": "glm_visual",
                            "severity": "high" if conf < 55 else "medium",
                            "start_ms": frame["time_ms"],
                            "end_ms": frame["time_ms"] + 5000,
                            "evidence": {"description": issue, "confidence_score": conf},
                        }
                        event_id = await db.add_event(
                            session_id=session_id,
                            event_type="issue",
                            category="glm_visual",
                            severity=event_payload["severity"],
                            start_ms=frame["time_ms"],
                            end_ms=frame["time_ms"] + 5000,
                            evidence=event_payload["evidence"],
                        )
                        event_payload["id"] = event_id
                        await manager.broadcast(session_id, {"type": "report.event", "event": event_payload})

                highlights = result.get("highlights") or []
                # Only emit highlight when confidence is reasonably high
                if (
                    isinstance(highlights, list)
                    and highlights
                    and conf >= 65
                    and glm_highlight_count < max_glm_highlights
                ):
                    highlight = str(highlights[0] or "").strip()
                    key = f"hl::{highlight.lower()}"
                    if highlight and key not in seen_glm_notes:
                        seen_glm_notes.add(key)
                        glm_highlight_count += 1
                        event_payload = {
                            "type": "highlight",
                            "category": "glm_visual",
                            "severity": "low",
                            "start_ms": frame["time_ms"],
                            "end_ms": frame["time_ms"] + 5000,
                            "evidence": {"description": highlight, "confidence_score": conf},
                        }
                        event_id = await db.add_event(
                            session_id=session_id,
                            event_type="highlight",
                            category="glm_visual",
                            severity="low",
                            start_ms=frame["time_ms"],
                            end_ms=frame["time_ms"] + 5000,
                            evidence=event_payload["evidence"],
                        )
                        event_payload["id"] = event_id
                        await manager.broadcast(session_id, {"type": "report.event", "event": event_payload})
            except Exception as e:
                print(f"Frame analysis failed: {e}")

            # Privacy: delete keyframe file after analysis (no local retention)
            try:
                Path(frame["path"]).unlink(missing_ok=True)
            except Exception:
                pass
        
        segments = await db.get_transcript_segments(session_id)
        total_chars = sum(len(s.get("text", "")) for s in segments)
        avg_speed = 0
        if duration_sec > 0:
            avg_speed = int(total_chars / (duration_sec / 60.0))

        # Calculate scores
        await manager.broadcast(session_id, {"type": "analysis.progress", "progress": 75, "stage": "scoring"})
        events = await db.get_events(session_id)
        scores = calculate_scores(
            events,
            audio_features,
            glm_results,
            duration_sec=duration_sec,
            total_chars=total_chars,
        )
        
        # Generate improvement suggestions
        await manager.broadcast(session_id, {"type": "analysis.progress", "progress": 85, "stage": "suggestions"})

        metrics = {
            "avg_speed": avg_speed,
            "filler_count": len([e for e in events if e.get("category") == "filler_word"]),
            "head_down_count": len([e for e in events if e.get("category") == "head_down"]),
            "duration_sec": duration_sec
        }
        suggestions = await glm_analyzer.generate_improvement_suggestions(events, metrics)
        
        # Update session
        await db.update_session(
            session_id,
            status="completed",
            duration_ms=int(duration_sec * 1000),
            total_score=scores["total"],
            scores_json=json.dumps(scores)
        )
        
        # Save analysis results
        analysis_dir = session_dir / "analysis"
        analysis_dir.mkdir(exist_ok=True)
        
        with open(analysis_dir / "report.json", "w", encoding="utf-8") as f:
            json.dump({
                "scores": scores,
                "suggestions": suggestions,
                "avg_speed": avg_speed,
                "audio_stats": {
                    "f0_stats": audio_features.get("f0_stats", {}),
                    "energy_stats": audio_features.get("energy_stats", {}),
                    "monotone_segments": audio_features.get("monotone_segments", [])
                },
                "glm_results": glm_results
            }, f, ensure_ascii=False, indent=2)

        await manager.broadcast(session_id, {"type": "analysis.progress", "progress": 100, "stage": "done"})
        await manager.broadcast(session_id, {"type": "report.ready"})
        
    except Exception as e:
        print(f"Analysis failed for session {session_id}: {e}")
        await db.update_session(session_id, status="error")

def calculate_scores(events: List, audio_features: dict, glm_results: List, *, duration_sec: float, total_chars: int) -> dict:
    """
    Calculate scores.

    PRD/方案口径（五维）：
    - logic (逻辑)
    - fluency (流畅度)
    - delivery (肢体表达)
    - emotion (情感表达)
    - pacing (时间节奏)

    兼容字段：
    - nonverbal 作为 delivery 别名
    - structure 作为 logic 别名（历史口径）
    """
    # Count issues by category
    issue_counts: dict[str, int] = {}
    for e in events:
        if e.get("type") == "issue":
            cat = e.get("category", "other")
            issue_counts[cat] = issue_counts.get(cat, 0) + 1

    # Data quality gates: prevent inflated scores when evidence is missing
    flags: list[str] = []
    has_transcript = total_chars >= 20
    if not has_transcript:
        flags.append("no_speech_transcript")
        issue_counts["no_speech_transcript"] = issue_counts.get("no_speech_transcript", 0) + 1

    audio_has_error = bool(audio_features and audio_features.get("error"))
    has_audio_features = bool(
        audio_features
        and not audio_has_error
        and (audio_features.get("f0_curve") or audio_features.get("energy_curve"))
    )
    if not has_audio_features:
        flags.append("no_audio_features")
        issue_counts["no_audio_features"] = issue_counts.get("no_audio_features", 0) + 1

    has_visual_results = bool(glm_results)
    avg_visual_confidence: float | None = None
    if has_visual_results:
        try:
            avg_visual_confidence = float(
                sum(float(r.get("confidence_score", 50) or 50) for r in glm_results) / len(glm_results)
            )
        except Exception:
            avg_visual_confidence = 50.0
    else:
        flags.append("no_visual_results")
        issue_counts["no_visual_results"] = issue_counts.get("no_visual_results", 0) + 1
    
    # Fluency score - 侧重口头禅 / 停顿 / 语速极端
    filler_penalty = min(10, issue_counts.get("filler_word", 0) * 1.5)  # 从15->10, 2->1.5
    pause_penalty = min(8, issue_counts.get("pause_long", 0) * 2)  # 从10->8, 3->2
    speed_penalty = min(5, (issue_counts.get("speed_fast", 0) + issue_counts.get("speed_slow", 0)) * 1.5)  # 2->1.5
    fluency = max(0, 100 - filler_penalty - pause_penalty - speed_penalty)
    # If we have no transcript, fluency cannot be assessed.
    if not has_transcript:
        fluency = 0
    
    # Nonverbal score (25%) - 减少惩罚力度
    head_penalty = min(15, issue_counts.get("head_down", 0) * 3)  # 从20->15, 4->3
    gaze_penalty = min(12, issue_counts.get("look_away", 0) * 2.5)  # 从15->12, 3->2.5
    posture_penalty = min(8, issue_counts.get("posture", 0) * 1.5)  # 从10->8, 2->1.5
    
    # Add GLM visual analysis adjustment (bonus for high confidence, penalty for low confidence)
    glm_adjust = 0.0
    if avg_visual_confidence is not None:
        if avg_visual_confidence >= 65:
            glm_adjust = (avg_visual_confidence - 50) / 5  # up to about +10
        elif avg_visual_confidence < 55:
            flags.append("low_visual_confidence")
            issue_counts["low_visual_confidence"] = issue_counts.get("low_visual_confidence", 0) + 1
            glm_adjust = -min(30.0, (55.0 - avg_visual_confidence) * 2.0)

    delivery = max(0, min(100, 100 - head_penalty - gaze_penalty - posture_penalty + glm_adjust))

    # If visual confidence is low, cap nonverbal to avoid "blind" high scores.
    if avg_visual_confidence is not None and avg_visual_confidence < 55:
        delivery = min(delivery, 60 if avg_visual_confidence >= 50 else 50)
    # If there is effectively no reliable visual evidence, avoid defaulting to 100.
    has_nonverbal_events = any(
        issue_counts.get(k, 0) > 0 for k in ("head_down", "look_away", "posture", "glm_visual")
    )
    if not has_nonverbal_events and (duration_sec or 0) >= 5:
        flags.append("no_nonverbal_evidence")
        issue_counts["no_nonverbal_evidence"] = issue_counts.get("no_nonverbal_evidence", 0) + 1
        delivery = min(delivery, 50)
    
    # Emotion score (20%) - 提高基础分，即使没有音频特征也给予基础分
    f0_stats = (audio_features or {}).get("f0_stats", {})
    energy_stats = (audio_features or {}).get("energy_stats", {})

    # 即使音频特征缺失，也给予基础分（从0改为60）
    if not has_audio_features:
        emotion = 60  # 给予基础分，避免直接为0
    else:
        # Check for monotone speaking
        f0_std = float(f0_stats.get("std", 0) or 0)
        energy_range = float(energy_stats.get("range", 0) or 0)

        emotion = 75  # 提高基础分 (70->75)
        if f0_std >= 30:
            emotion += 15
        elif f0_std < 25:
            emotion -= 8  # 减少惩罚 (10->8)

        if energy_range >= 10:
            emotion += 15
        elif energy_range < 6:
            emotion -= 8  # 减少惩罚 (10->8)

        emotion = max(0, min(100, emotion))
    
    # Logic score (方案口径：Logic)
    # 这里用“结构/连贯性”的可观测信号做启发式评分（避免额外 LLM 调用）。
    logic = 85
    if not has_transcript:
        logic = 65
    else:
        logic -= min(10, issue_counts.get("filler_word", 0) * 0.8)
        logic -= min(10, issue_counts.get("pause_long", 0) * 1.2)
        logic = max(0, min(100, logic))

    # Pacing score (方案口径：Time/Pacing)
    # 以整体平均语速 + 过长停顿 + 极端语速事件综合评估节奏控制。
    pacing = 85
    if not has_transcript or duration_sec <= 0:
        pacing = 65
    else:
        avg_cpm = 0
        try:
            avg_cpm = int(total_chars / (duration_sec / 60.0)) if duration_sec > 0 else 0
        except Exception:
            avg_cpm = 0

        # Avg CPM banding (soft penalties)
        if avg_cpm:
            if avg_cpm > 300:
                pacing -= 20
            elif avg_cpm > 260:
                pacing -= 10
            elif avg_cpm < 110:
                pacing -= 20
            elif avg_cpm < 140:
                pacing -= 10

        pacing -= min(20, issue_counts.get("pause_long", 0) * 4)
        pacing -= min(15, (issue_counts.get("speed_fast", 0) + issue_counts.get("speed_slow", 0)) * 3)
        pacing = max(0, min(100, pacing))
    
    # Total: five dimensions (equal weight), coverage-aware
    weights = {
        "logic": 0.20,
        "fluency": 0.20,
        "delivery": 0.20,
        "emotion": 0.20,
        "pacing": 0.20,
    }
    available = {
        "fluency": has_transcript,
        "logic": True,
        "pacing": True,
        "emotion": True,
        "delivery": bool(has_nonverbal_events or has_visual_results),
    }
    denom = sum(w for k, w in weights.items() if available.get(k))
    coverage = denom

    # 只有当覆盖率低于0.5时才标记数据不足（原来是<=0）
    if denom < 0.5:
        total = 0.0
        flags.append("insufficient_data")
        issue_counts["insufficient_data"] = issue_counts.get("insufficient_data", 0) + 1
    else:
        normalized = (
            (logic * weights["logic"] if available["logic"] else 0)
            + (fluency * weights["fluency"] if available["fluency"] else 0)
            + (delivery * weights["delivery"] if available["delivery"] else 0)
            + (emotion * weights["emotion"] if available["emotion"] else 0)
            + (pacing * weights["pacing"] if available["pacing"] else 0)
        ) / denom
        # 提高最终总分（乘以1.05作为bonus）
        total = min(100, normalized * coverage * 1.05)

    return {
        "total": round(total, 1),
        "logic": round(logic, 1),
        "fluency": round(fluency, 1),
        "delivery": round(delivery, 1),
        "emotion": round(emotion, 1),
        "pacing": round(pacing, 1),
        # Backward-compatible aliases
        "nonverbal": round(delivery, 1),
        "structure": round(logic, 1),
        "issue_counts": issue_counts,
        "data_quality": {
            "coverage": round(coverage, 2),
            "flags": flags,
            "total_chars": int(total_chars),
            "has_audio_features": bool(has_audio_features),
            "avg_visual_confidence": avg_visual_confidence,
        },
    }

@router.post("/{session_id}/upload/video")
async def upload_video(session_id: str, video: UploadFile = File(...)):
    """Upload recorded video"""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session_dir = get_session_dir(session_id)
    ext = Path(video.filename or "video.webm").suffix.lower() or ".webm"
    video_path = session_dir / f"video{ext}"
    
    with open(video_path, "wb") as f:
        content = await video.read()
        f.write(content)
    
    await db.update_session(session_id, video_path=str(video_path))
    
    return {"status": "uploaded", "path": str(video_path)}

@router.get("/{session_id}/video")
async def get_video(session_id: str):
    """Stream video file"""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    video_path = Path(session.get("video_path") or "")
    if not video_path:
        # Fallback legacy path
        session_dir = get_session_dir(session_id)
        video_path = session_dir / "video.webm"
    
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    
    return FileResponse(
        video_path,
        media_type="video/webm" if video_path.suffix.lower() == ".webm" else "video/mp4",
        filename=video_path.name
    )

@router.get("/{session_id}/report")
async def get_report(session_id: str):
    """Get analysis report"""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session_dir = get_session_dir(session_id)
    report_path = session_dir / "analysis" / "report.json"
    
    if report_path.exists():
        with open(report_path, "r", encoding="utf-8") as f:
            report = json.load(f)
    else:
        report = {}
    
    # Get all related data
    events = await db.get_events(session_id)
    segments = await db.get_transcript_segments(session_id)
    slides = await db.get_slides(session_id)
    metrics = await db.get_metrics_series(session_id)

    # Compute per-slide basic summaries for PPT mode
    slides_summary: list[dict[str, Any]] = []
    if slides:
        for slide in slides:
            idx = slide.get("slide_index")
            slide_events = [e for e in events if e.get("slide_index") == idx]
            slide_segments = [s for s in segments if s.get("slide_index") == idx]
            start_ms = slide.get("start_ms")
            end_ms = slide.get("end_ms")
            duration_ms = None
            if isinstance(start_ms, int) and isinstance(end_ms, int) and end_ms > start_ms:
                duration_ms = end_ms - start_ms
            else:
                if slide_segments:
                    duration_ms = (slide_segments[-1].get("end_ms", 0) or 0) - (slide_segments[0].get("start_ms", 0) or 0)

            filler_count = len([e for e in slide_events if e.get("category") == "filler_word"])
            head_down_count = len([e for e in slide_events if e.get("category") == "head_down"])
            look_away_count = len([e for e in slide_events if e.get("category") == "look_away"])

            total_chars = sum(len(s.get("text", "")) for s in slide_segments)
            speed_cpm = 0
            if duration_ms and duration_ms > 0:
                speed_cpm = int(total_chars / (duration_ms / 1000.0 / 60.0))

            slides_summary.append({
                "slide_index": idx,
                "duration_ms": duration_ms,
                "speed_cpm": speed_cpm,
                "filler_count": filler_count,
                "head_down_count": head_down_count,
                "look_away_count": look_away_count,
            })
    
    # Load script text if available
    script_text: str | None = None
    script_path = session.get("script_path")
    if script_path:
        try:
            p = Path(str(script_path))
            if p.exists():
                script_text = _read_script_file(p)
        except Exception:
            script_text = None
    
    return {
        "session": session,
        "report": report,
        "events": events,
        "transcript_segments": segments,
        "slides": slides,
        "metrics": {m["name"]: m.get("series", []) for m in metrics},
        "slides_summary": slides_summary,
        "script_text": script_text,
    }

@router.get("/{session_id}/slides/{slide_index}/image")
async def get_slide_image(session_id: str, slide_index: int):
    """Get slide image"""
    session_dir = get_session_dir(session_id)
    image_path = session_dir / "slides" / f"slide_{slide_index:04d}.png"
    
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Slide image not found")
    
    return FileResponse(image_path, media_type="image/png")

@router.delete("/{session_id}")
async def delete_session(session_id: str):
    """Delete session and all related data"""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Delete files
    session_dir = get_session_dir(session_id)
    if session_dir.exists():
        shutil.rmtree(session_dir)
    
    # Delete from database
    await db.delete_session(session_id)
    
    return {"status": "deleted", "session_id": session_id}

@router.delete("")
async def delete_all_sessions():
    """Delete all sessions and reset to factory state (恢复出厂设置)"""
    # Get all sessions first
    all_sessions = await db.list_sessions(limit=10000)
    
    deleted_count = 0
    errors = []
    
    for session in all_sessions:
        session_id = session.get("id")
        if not session_id:
            continue
        try:
            # Delete files
            session_dir = get_session_dir(session_id)
            if session_dir.exists():
                shutil.rmtree(session_dir)
            
            # Delete from database
            await db.delete_session(session_id)
            deleted_count += 1
        except Exception as e:
            errors.append({"session_id": session_id, "error": str(e)})
    
    # Also clear the sessions directory in case there are orphan folders
    try:
        if settings.SESSIONS_DIR.exists():
            for child in settings.SESSIONS_DIR.iterdir():
                if child.is_dir():
                    try:
                        shutil.rmtree(child)
                    except Exception:
                        pass
    except Exception:
        pass
    
    return {
        "status": "reset_complete",
        "deleted_count": deleted_count,
        "errors": errors if errors else None,
        "message": "所有练习数据已清空，系统已恢复出厂状态"
    }


@router.post("/{session_id}/export/pdf")
async def export_pdf(session_id: str, background_tasks: BackgroundTasks):
    """Generate PDF report"""
    session = await db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session_dir = get_session_dir(session_id)
    pdf_path = session_dir / "analysis" / "report.pdf"
    pdf_path.parent.mkdir(parents=True, exist_ok=True)

    report_payload = await get_report(session_id)
    try:
        await generate_session_pdf(report_payload, str(pdf_path))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}")

    return {"status": "ok", "url": f"/api/sessions/{session_id}/export/pdf"}


@router.get("/{session_id}/export/pdf")
async def download_pdf(session_id: str):
    """Download generated PDF report"""
    session_dir = get_session_dir(session_id)
    pdf_path = session_dir / "analysis" / "report.pdf"
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not generated")

    return FileResponse(pdf_path, media_type="application/pdf", filename=f"{session_id}.pdf")

@router.get("/compare/{session_id_1}/{session_id_2}")
async def compare_sessions(session_id_1: str, session_id_2: str):
    """Compare two sessions"""
    session1 = await db.get_session(session_id_1)
    session2 = await db.get_session(session_id_2)
    
    if not session1 or not session2:
        raise HTTPException(status_code=404, detail="One or both sessions not found")
    
    # Get metrics for both sessions
    metrics1 = await db.get_metrics_series(session_id_1)
    metrics2 = await db.get_metrics_series(session_id_2)
    
    events1 = await db.get_events(session_id_1)
    events2 = await db.get_events(session_id_2)
    
    return {
        "session1": {
            "info": session1,
            "metrics": {m["name"]: m.get("series", []) for m in metrics1},
            "event_summary": _summarize_events(events1)
        },
        "session2": {
            "info": session2,
            "metrics": {m["name"]: m.get("series", []) for m in metrics2},
            "event_summary": _summarize_events(events2)
        }
    }

def _summarize_events(events: List) -> dict:
    """Summarize events for comparison"""
    summary = {
        "total_issues": 0,
        "total_highlights": 0,
        "by_category": {}
    }
    
    for e in events:
        if e.get("type") == "issue":
            summary["total_issues"] += 1
        else:
            summary["total_highlights"] += 1
        
        cat = e.get("category", "other")
        summary["by_category"][cat] = summary["by_category"].get(cat, 0) + 1
    
    return summary
