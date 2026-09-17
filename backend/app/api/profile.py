"""Speaker profile API.

Aggregates historical sessions/events and (optionally) uses GLM to generate style tags
and weekly focus.
"""

from __future__ import annotations

import json

from fastapi import APIRouter

from ..models import database as db
from ..services import glm_analyzer
from ..config import settings

router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("")
async def get_profile():
    sessions = await db.list_sessions(limit=200, offset=0)
    completed = [s for s in sessions if s.get("status") == "completed" and s.get("total_score")]

    if not completed:
        return {
            "totalSessions": 0,
            "totalDuration": 0,
            "avgScore": 0,
            "scoreHistory": [],
            "commonIssues": [],
            "strengths": [],
            "styleTags": [],
            "weeklyFocus": "",
            "milestones": [],
        }

    total_duration = sum(int(s.get("duration_ms") or 0) for s in completed)
    avg_score = sum(float(s.get("total_score") or 0) for s in completed) / max(1, len(completed))

    # Aggregate five-dimension averages from scores_json (with fallbacks)
    dims_sum = {"logic": 0.0, "fluency": 0.0, "delivery": 0.0, "emotion": 0.0, "pacing": 0.0}
    dims_n = 0
    for s in completed:
        raw = s.get("scores_json")
        if not raw:
            continue
        try:
            sj = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:
            continue
        if not isinstance(sj, dict):
            continue
        dims_sum["logic"] += float(sj.get("logic", sj.get("structure", 0)) or 0)
        dims_sum["fluency"] += float(sj.get("fluency", 0) or 0)
        dims_sum["delivery"] += float(sj.get("delivery", sj.get("nonverbal", 0)) or 0)
        dims_sum["emotion"] += float(sj.get("emotion", 0) or 0)
        dims_sum["pacing"] += float(sj.get("pacing", sj.get("structure", 0)) or 0)
        dims_n += 1

    avg_scores = None
    if dims_n > 0:
        avg_scores = {k: round(v / dims_n) for k, v in dims_sum.items()}

    score_history = [
        {
            "date": s.get("created_at"),
            "score": round(float(s.get("total_score") or 0)),
        }
        for s in completed[-10:]
    ]

    # Aggregate common issues across sessions
    issue_counts: dict[str, int] = {}
    history_for_llm = []
    for s in completed[-20:]:
        evs = await db.get_events(s["id"])
        cats = [e.get("category") for e in evs if e.get("type") == "issue" and e.get("category")]
        for c in cats:
            issue_counts[c] = issue_counts.get(c, 0) + 1
        history_for_llm.append({
            "created_at": s.get("created_at"),
            "total_score": s.get("total_score"),
            "issue_categories": list(sorted(set(cats)))
        })

    total_issues = sum(issue_counts.values()) or 1
    common_issues = [
        {
            "issue": k,
            "count": v,
            "percentage": round(v / total_issues * 100),
        }
        for k, v in sorted(issue_counts.items(), key=lambda x: -x[1])[:8]
    ]

    # Milestones
    first = completed[-1]
    first_80 = next((s for s in completed if float(s.get("total_score") or 0) >= 80), None)
    milestones = [
        {"title": "首次完成练习", "date": (first.get("created_at") or "").split("T")[0], "achieved": True},
        {"title": "首次达到 80 分", "date": (first_80.get("created_at") or "").split("T")[0] if first_80 else "", "achieved": bool(first_80)},
        {"title": "累计练习 10 次", "date": "", "achieved": len(completed) >= 10},
    ]

    profile = {
        "totalSessions": len(completed),
        "totalDuration": total_duration,
        "avgScore": round(avg_score),
        "avgScores": avg_scores,
        "scoreHistory": score_history,
        "commonIssues": common_issues,
        "strengths": [],
        "styleTags": [],
        "weeklyFocus": "",
        "milestones": milestones,
    }

    # Optional GLM enrichment
    if settings.ZHIPU_API_KEY:
        try:
            glm_profile = await glm_analyzer.generate_speaker_profile(history_for_llm)
            profile["styleTags"] = glm_profile.get("style_tags") or []
            profile["weeklyFocus"] = glm_profile.get("weekly_focus") or ""
            profile["strengths"] = glm_profile.get("strengths") or []
            # Map common issues if GLM provided a better list
            if glm_profile.get("common_issues"):
                profile["commonIssues"] = [
                    {
                        "issue": i.get("issue"),
                        "count": int(i.get("frequency") or 0),
                        "percentage": 0,
                    }
                    for i in glm_profile.get("common_issues")[:8]
                ]
        except Exception:
            # Keep heuristic profile if GLM call fails
            pass

    # Heuristic fallbacks when GLM is unavailable
    if not profile["styleTags"]:
        profile["styleTags"] = ["持续进步中"] if profile["avgScore"] < 80 else ["表达自信", "逻辑清晰"]
    if not profile["weeklyFocus"]:
        top_issue = profile["commonIssues"][0]["issue"] if profile["commonIssues"] else ""
        profile["weeklyFocus"] = f"本周重点：关注 {top_issue}，建议针对性练习并复盘。" if top_issue else "本周重点：保持练习并复盘。"
    if not profile["strengths"]:
        profile["strengths"] = ["持续练习", "复盘意识"]

    return profile
