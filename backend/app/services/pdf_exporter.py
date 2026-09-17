"""PDF report generation (ReportLab).

Generates a single-session report PDF containing:
- Basic session metadata
- Total score + 4-dim breakdown
- Suggestions
- Key issue counts and top events
- Simple charts (emotion curve if available)

This is designed to work on Windows without external system dependencies.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.graphics.shapes import Drawing, PolyLine, String
from reportlab.graphics.charts.textlabels import Label

# Global font name to use
_FONT_NAME = "STSong-Light"

def _register_fonts() -> None:
    """Register Chinese fonts with multiple fallback options."""
    global _FONT_NAME
    
    # Try Windows system fonts first (more complete character coverage)
    windows_fonts = [
        ("SimSun", "C:/Windows/Fonts/simsun.ttc"),
        ("SimHei", "C:/Windows/Fonts/simhei.ttf"),
        ("MicrosoftYaHei", "C:/Windows/Fonts/msyh.ttc"),
        ("KaiTi", "C:/Windows/Fonts/simkai.ttf"),
    ]
    
    for font_name, font_path in windows_fonts:
        try:
            if Path(font_path).exists():
                pdfmetrics.registerFont(TTFont(font_name, font_path))
                _FONT_NAME = font_name
                print(f"[PDF] Using font: {font_name}")
                return
        except Exception as e:
            print(f"[PDF] Failed to register {font_name}: {e}")
            continue
    
    # Fallback to built-in CJK font
    try:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        _FONT_NAME = "STSong-Light"
        print("[PDF] Using fallback font: STSong-Light")
    except Exception as e:
        print(f"[PDF] Failed to register STSong-Light: {e}")
        _FONT_NAME = "Helvetica"  # Last resort


def _safe_get(d: dict, path: str, default=None):
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def _build_emotion_chart(series: List[Tuple[int, float]], width: float, height: float) -> Drawing:
    d = Drawing(width, height)
    d.add(String(0, height - 12, "情感能量曲线", fontName=_FONT_NAME, fontSize=10))

    if not series:
        d.add(String(0, height / 2, "(无数据)", fontName=_FONT_NAME, fontSize=9, fillColor=colors.grey))
        return d

    xs = [t for t, _ in series]
    ys = [v for _, v in series]

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = 0, 100

    def map_x(x):
        if max_x == min_x:
            return 0
        return (x - min_x) / (max_x - min_x) * (width - 20) + 10

    def map_y(y):
        return (y - min_y) / (max_y - min_y) * (height - 30) + 10

    points = []
    for t, v in series[:: max(1, len(series) // 200)]:
        points.append(map_x(t))
        points.append(map_y(v))

    d.add(PolyLine(points, strokeColor=colors.HexColor("#10B981"), strokeWidth=1.2))
    d.add(String(10, 0, f"{int(min_x/1000)}s", fontName=_FONT_NAME, fontSize=7, fillColor=colors.grey))
    d.add(String(width - 30, 0, f"{int(max_x/1000)}s", fontName=_FONT_NAME, fontSize=7, fillColor=colors.grey))

    return d


async def generate_session_pdf(report_payload: Dict[str, Any], output_path: str) -> None:
    # Platypus is synchronous; wrap in to_thread to keep the API async-friendly.
    await asyncio.to_thread(_generate_session_pdf_sync, report_payload, output_path)


def _generate_session_pdf_sync(report_payload: Dict[str, Any], output_path: str) -> None:
    _register_fonts()

    session = report_payload.get("session", {})
    report = report_payload.get("report", {}) or {}
    scores = (report.get("scores") or {})
    ppt_prep = report.get("ppt_prep") or {}
    suggestions = report.get("suggestions") or ppt_prep.get("suggestions") or []
    events = report_payload.get("events", []) or []
    slides_summary = report_payload.get("slides_summary", []) or []
    metrics = report_payload.get("metrics", {}) or {}

    # Ensure suggestions are never empty in exports (avoid "无数据" UX)
    if not suggestions:
        avg_speed = metrics.get("avg_speed")
        filler_count = metrics.get("filler_count")
        head_down_count = metrics.get("head_down_count")
        look_away_count = metrics.get("look_away_count")

        fallback: List[str] = []
        if isinstance(avg_speed, (int, float)) and avg_speed > 0:
            if avg_speed > 240:
                fallback.append(f"语速偏快（约 {int(avg_speed)} 字/分钟）。用 60 秒计时朗读训练，把关键句刻意放慢并加入 0.5-1 秒停顿。")
            elif avg_speed < 160:
                fallback.append(f"语速偏慢（约 {int(avg_speed)} 字/分钟）。把每句主谓宾说完整后再停顿，避免拖长句尾。")
            else:
                fallback.append(f"语速在舒适区（约 {int(avg_speed)} 字/分钟）。把数字/结论处放慢 10%-15% 做强调。")
        else:
            fallback.append("建议先完成一次完整录制，生成语速与节奏数据后再针对性训练。")

        if isinstance(filler_count, (int, float)) and filler_count > 0:
            fallback.append(f"口头禅检测到 {int(filler_count)} 次。把“嗯/啊/然后”改成短暂停顿，并用‘下一点’‘关键是’替代连接词。")
        else:
            fallback.append("口头禅控制较好。继续保持句子结尾的干净收束。")

        if any(isinstance(x, (int, float)) and x and x > 0 for x in [head_down_count, look_away_count]):
            fallback.append("镜头交流可再加强：把摄像头旁贴一个小标记，讲关键结论时看向标记 1-2 秒。")
        else:
            fallback.append("镜头交流整体不错。可在转场句时做一次‘扫视’来带动听众注意力。")

        suggestions = fallback[:3]

    styles = getSampleStyleSheet()
    normal = styles["Normal"]
    normal.fontName = _FONT_NAME

    title_style = styles["Title"]
    title_style.fontName = _FONT_NAME
    
    # Also update Heading styles
    for heading in ["Heading1", "Heading2", "Heading3"]:
        if heading in styles:
            styles[heading].fontName = _FONT_NAME

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title="AI演说家 评估报告",
    )

    elements = []

    elements.append(Paragraph("AI演说家 - 单次练习评估报告", title_style))
    elements.append(Spacer(1, 6 * mm))

    created_at = session.get("created_at")
    try:
        created_at_fmt = datetime.fromisoformat(created_at).strftime("%Y-%m-%d %H:%M:%S") if created_at else ""
    except Exception:
        created_at_fmt = str(created_at or "")

    # 将 mode 代码转换为友好的中文显示名称
    mode_display = {
        "ppt": "PPT演示模式",
        "ppt_analysis": "PPT备稿分析",
        "script": "演讲稿模式",
        "script_analysis": "演讲稿分析",
        "free": "自由演讲模式",
        "upload": "视频上传分析",
    }.get(session.get("mode", ""), session.get("mode", ""))
    
    # 格式化时长
    duration_ms = session.get("duration_ms", 0) or 0
    if duration_ms > 0:
        minutes = int(duration_ms // 60000)
        seconds = int((duration_ms % 60000) // 1000)
        duration_display = f"{minutes} 分 {seconds} 秒"
    else:
        duration_display = "—"
    
    meta_table = Table(
        [
            ["会话ID", session.get("id", "")],
            ["标题", session.get("title", "")],
            ["模式", mode_display],
            ["时间", created_at_fmt],
            ["时长", duration_display],
        ],
        colWidths=[28 * mm, 140 * mm],
    )
    meta_table.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), _FONT_NAME),
                ("BACKGROUND", (0, 0), (0, -1), colors.whitesmoke),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.lightgrey),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    elements.append(meta_table)
    elements.append(Spacer(1, 6 * mm))

    if session.get("mode") != "ppt_analysis":
        logic = scores.get("logic", scores.get("structure", 0))
        delivery = scores.get("delivery", scores.get("nonverbal", 0))
        pacing = scores.get("pacing", scores.get("structure", 0))
        score_table = Table(
            [
                ["总分", scores.get("total", 0)],
                ["逻辑", logic],
                ["流畅度", scores.get("fluency", 0)],
                ["肢体表达", delivery],
                ["情感表达", scores.get("emotion", 0)],
                ["时间节奏", pacing],
            ],
            colWidths=[28 * mm, 40 * mm],
        )
        score_table.setStyle(
            TableStyle(
                [
                    ("FONT", (0, 0), (-1, -1), _FONT_NAME),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.lightgrey),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0F172A")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ]
            )
        )
        elements.append(Paragraph("评分概览", styles["Heading2"]))
        elements.append(score_table)
        elements.append(Spacer(1, 5 * mm))

    # Suggestions
    elements.append(Paragraph("AI改进建议", styles["Heading2"]))
    if suggestions:
        for i, s in enumerate(suggestions[:3], 1):
            elements.append(Paragraph(f"{i}. {s}", normal))
    else:
        elements.append(Paragraph("1. 建议先完成一次完整练习以生成可复盘数据。", normal))
        elements.append(Paragraph("2. 练习时在关键结论处放慢语速并加入停顿。", normal))
        elements.append(Paragraph("3. 录制回放时标记 3 个需要改写的句子逐句优化。", normal))
    elements.append(Spacer(1, 5 * mm))

    # PPT prep-only section
    if session.get("mode") == "ppt_analysis" and isinstance(ppt_prep, dict) and ppt_prep:
        elements.append(Paragraph("PPT备稿分析报告", styles["Heading2"]))
        
        # 主线说明
        storyline = ppt_prep.get("deck_storyline") or ""
        if storyline:
            elements.append(Paragraph(f"演讲主线：{storyline}", normal))
        
        overall = ppt_prep.get("overall_structure") or ""
        if overall:
            elements.append(Paragraph(f"整体结构评价：{overall}", normal))

        total_sec = ppt_prep.get("estimated_total_duration_sec")
        if isinstance(total_sec, (int, float)) and total_sec > 0:
            elements.append(Paragraph(f"预计总时长：约 {int(round(total_sec / 60))} 分钟", normal))
        
        # PPT 评分
        ppt_scores = ppt_prep.get("scores") or {}
        if ppt_scores:
            elements.append(Spacer(1, 2 * mm))
            elements.append(Paragraph(f"PPT评分：综合 {ppt_scores.get('total', '--')} | 结构 {ppt_scores.get('structure', '--')} | 逻辑 {ppt_scores.get('logic', '--')} | 内容 {ppt_scores.get('content', '--')}", normal))
        
        elements.append(Spacer(1, 3 * mm))

        outline = ppt_prep.get("outline") or []
        if isinstance(outline, list) and outline:
            elements.append(Paragraph("逐页要点与演讲稿", styles["Heading3"]))
            for item in outline[:15]:  # 增加到15页
                if not isinstance(item, dict):
                    continue
                idx = item.get("slide_index")
                title = item.get("title") or ""
                page_type = item.get("page_type") or ""
                est_sec = item.get("estimated_duration_sec")
                
                header = f"第 {idx} 页" if idx is not None else "一页"
                if title:
                    header += f"：{title}"
                if page_type:
                    header += f" [{page_type}]"
                if est_sec and isinstance(est_sec, (int, float)):
                    header += f" (~{int(est_sec)}秒)"
                    
                elements.append(Paragraph(header, normal))
                
                # 核心要点
                kps = item.get("key_points") or []
                if isinstance(kps, list) and kps:
                    elements.append(Paragraph("核心要点：", normal))
                    for kp in kps[:4]:
                        if kp:
                            elements.append(Paragraph(f"  • {kp}", normal))
                
                # 建议演讲稿
                script = item.get("suggested_script") or ""
                if script:
                    elements.append(Paragraph(f"建议演讲稿：{script}", normal))
                
                # 讲解技巧
                tips = item.get("speaking_tips") or ""
                if tips:
                    elements.append(Paragraph(f"讲解技巧：{tips}", normal))
                
                # 过渡建议
                transition = item.get("transition_hint") or ""
                if transition:
                    elements.append(Paragraph(f"过渡建议：{transition}", normal))
                    
                elements.append(Spacer(1, 3 * mm))

    # Script Analysis mode section
    script_analysis = report.get("script_analysis")
    if session.get("mode") == "script_analysis" and isinstance(script_analysis, dict) and script_analysis:
        elements.append(Paragraph("演讲稿分析报告", styles["Heading2"]))
        
        # Word count and duration
        word_count = script_analysis.get("word_count", 0)
        est_duration = script_analysis.get("estimated_duration_sec", 0)
        if word_count:
            elements.append(Paragraph(f"字数：{word_count} 字", normal))
        if est_duration:
            mins = int(est_duration // 60)
            secs = int(est_duration % 60)
            elements.append(Paragraph(f"预估时长：约 {mins} 分 {secs} 秒", normal))
        
        # Scores
        opening_score = script_analysis.get("opening_hook_score", 0)
        logic_score = script_analysis.get("logic_flow_score", 0)
        emotion_score = script_analysis.get("emotional_appeal_score", 0)
        overall_score = script_analysis.get("overall_score", 0)
        if opening_score or logic_score or emotion_score:
            elements.append(Paragraph(f"评分：开场 {opening_score} / 逻辑 {logic_score} / 感染力 {emotion_score} / 综合 {overall_score}", normal))
        elements.append(Spacer(1, 2 * mm))
        
        # Structure
        structure = script_analysis.get("structure", {})
        if structure:
            struct_info = []
            if structure.get("has_opening"):
                struct_info.append(f"开场({structure.get('opening_type', '未知')})")
            if structure.get("has_body"):
                struct_info.append(f"正文({structure.get('body_logic', '未知')})")
            if structure.get("has_closing"):
                struct_info.append(f"结尾({structure.get('closing_type', '未知')})")
            if struct_info:
                elements.append(Paragraph(f"结构：{' → '.join(struct_info)}", normal))
        
        # Strengths
        strengths = script_analysis.get("strengths", [])
        if strengths:
            elements.append(Paragraph("优点：", normal))
            for s in strengths[:3]:
                elements.append(Paragraph(f"✓ {s}", normal))
        
        # Issues
        issues = script_analysis.get("issues", [])
        if issues:
            elements.append(Paragraph("问题：", normal))
            for s in issues[:3]:
                elements.append(Paragraph(f"✗ {s}", normal))
        
        # Revision examples
        revision_examples = script_analysis.get("revision_examples", [])
        if revision_examples:
            elements.append(Spacer(1, 2 * mm))
            elements.append(Paragraph("修改示例：", normal))
            for ex in revision_examples[:3]:
                if isinstance(ex, dict):
                    loc = ex.get("location", "")
                    orig = ex.get("original", "")
                    rev = ex.get("revised", "")
                    if orig and rev:
                        elements.append(Paragraph(f"【{loc}】原文：{orig}", normal))
                        elements.append(Paragraph(f"→ 修改为：{rev}", normal))
        
        elements.append(Spacer(1, 3 * mm))

    # Issue summary
    elements.append(Paragraph("问题与高光摘要", styles["Heading2"]))
    
    # 事件类别的中文显示名称
    category_display = {
        "filler_word": "口头禅",
        "speed_fast": "语速过快",
        "speed_slow": "语速过慢",
        "head_down": "低头",
        "look_away": "视线偏离",
        "pause_long": "停顿过长",
        "glm_visual": "视觉表现问题",
        "posture": "姿态问题",
        "body_sway": "身体晃动",
        "no_speech_transcript": "语音数据",
        "no_audio_features": "音频数据",
        "no_visual_results": "视觉数据",
        "insufficient_data": "数据不足",
    }
    
    issue_counts: Dict[str, int] = {}
    highlight_count = 0
    for e in events:
        if e.get("type") == "highlight":
            highlight_count += 1
        cat = e.get("category", "other")
        issue_counts[cat] = issue_counts.get(cat, 0) + 1

    # 转换事件类别为中文名称
    summary_rows = [["事件类别", "数量"]] + sorted(
        [[category_display.get(k, k), v] for k, v in issue_counts.items()], 
        key=lambda x: -x[1]
    )[:10]
    summary_rows.append(["亮点事件", highlight_count])
    summary_table = Table(summary_rows, colWidths=[90 * mm, 25 * mm])
    summary_table.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), _FONT_NAME),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.lightgrey),
                ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
            ]
        )
    )
    elements.append(summary_table)
    elements.append(Spacer(1, 5 * mm))

    # PPT per-slide summary (if available)
    if slides_summary:
        elements.append(Paragraph("分页摘要（PPT模式）", styles["Heading2"]))
        rows = [["页", "用时(s)", "语速(字/分)", "口头禅", "低头", "偏离"]]
        for s in slides_summary:
            dur = s.get("duration_ms") or 0
            rows.append(
                [
                    str(s.get("slide_index")),
                    str(int(dur / 1000) if dur else ""),
                    str(s.get("speed_cpm") or ""),
                    str(s.get("filler_count") or 0),
                    str(s.get("head_down_count") or 0),
                    str(s.get("look_away_count") or 0),
                ]
            )
        t = Table(rows, colWidths=[12 * mm, 22 * mm, 26 * mm, 16 * mm, 16 * mm, 16 * mm])
        t.setStyle(
            TableStyle(
                [
                    ("FONT", (0, 0), (-1, -1), _FONT_NAME),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.lightgrey),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
                ]
            )
        )
        elements.append(t)
        elements.append(Spacer(1, 5 * mm))

    # Emotion curve chart
    emotion_curve = metrics.get("emotion_curve") or []
    if emotion_curve:
        elements.append(Paragraph("核心图表", styles["Heading2"]))
        elements.append(_build_emotion_chart(emotion_curve, width=170 * mm, height=50 * mm))

    doc.build(elements)
