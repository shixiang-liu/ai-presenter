"""
GLM-4.6V-Flash Analyzer Service
Handles image analysis for expressions, gestures, and content understanding
"""
import asyncio
import base64
from pathlib import Path
from typing import Dict, List, Optional, Any
import ast
from zhipuai import ZhipuAI
from ..config import settings

# Semaphore for concurrency control (max 3 concurrent requests)
_glm_semaphore = asyncio.Semaphore(3)

def get_client() -> ZhipuAI:
    """Get ZhipuAI client"""
    return ZhipuAI(api_key=settings.ZHIPU_API_KEY)

def image_to_base64(image_path: str) -> str:
    """Convert image file to base64 string"""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def _extract_json_payload(text: str) -> Any:
    """Best-effort JSON extraction for LLM outputs.

    We ask for strict JSON, but models occasionally wrap it in code fences or
    include minor formatting issues. This helper tries:
    - fenced ```json blocks
    - first {...} object substring
    - json.loads
    - ast.literal_eval fallback (handles single quotes in dict/list)
    """
    import json
    import re

    raw = (text or "").strip()
    if not raw:
        raise ValueError("empty content")

    # Strip code fences
    if "```" in raw:
        if "```json" in raw:
            raw = raw.split("```json", 1)[1].split("```", 1)[0].strip()
        else:
            raw = raw.split("```", 1)[1].split("```", 1)[0].strip()

    # If still not starting with JSON, try locate first object/array
    if not (raw.startswith("{") or raw.startswith("[")):
        m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", raw)
        if m:
            raw = m.group(1).strip()

    # First attempt: strict JSON
    try:
        return json.loads(raw)
    except Exception:
        pass

    # Second attempt: python literal (single quotes etc.)
    try:
        val = ast.literal_eval(raw)
        return val
    except Exception as e:
        raise ValueError(f"failed to parse json payload: {e}")


async def analyze_document_directly(
    file_path: str,
    *,
    page_count: Optional[int] = None,
) -> Dict[str, Any]:
    """
    使用 GLM-4.6V-Flash 原生文件理解能力，直接分析 PDF/PPTX 文件。
    
    GLM-4.6V-Flash 支持直接输入 file_url，可以一次性理解整个文档，
    比逐页转图片再分析更高效，也能更好地理解上下文连贯性。
    
    Args:
        file_path: 本地 PDF 或 PPTX 文件路径
        page_count: 可选，文档总页数（用于提示）
    
    Returns:
        包含每页分析结果的字典
    """
    async with _glm_semaphore:
        client = get_client()
        
        # 读取文件并转为 base64 data URL
        file_bytes = Path(file_path).read_bytes()
        file_b64 = base64.b64encode(file_bytes).decode("utf-8")
        
        # 判断文件类型
        suffix = Path(file_path).suffix.lower()
        if suffix in ('.pptx', '.ppt'):
            mime_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        elif suffix == '.pdf':
            mime_type = "application/pdf"
        else:
            mime_type = "application/octet-stream"
        
        page_hint = f"（共{page_count}页）" if page_count else ""
        
        prompt = f"""你是为TED演讲者和商业高管服务的顶级演讲教练。请分析这份演示文稿{page_hint}，为每一页生成专业的演讲辅导内容。

## 核心任务：生成"像讲故事一样"的连续演讲稿

请先通读整份文档，理解其叙事脉络（如：问题→方案→证据→结论），然后：

1. **生成完整演讲稿 (full_script)**：整套PPT的连续演讲稿，用【1】【2】...【N】标记每页
2. **生成每页分析 (slides)**：包含每页的标题、要点、讲解技巧、过渡建议

## 写作要求

❌ **绝对禁止**：
- 每页都用"首先/其次/最后"开头
- 使用"如图所示"、"我们可以看到"、"众所周知"
- 内容页出现"大家好"等问候语（仅封面页可用）

✅ **必须做到**：
- 以**本页核心名词/数据/结论**开场
- 每页结尾用**问题或悬念**引向下一页
- 讲解技巧必须**引用页面具体内容**（如"讲到'2部电梯'时伸出两指"）
- 过渡建议必须用问题句式，不要用"接下来我们将..."

请返回严格 JSON：
{{
    "full_script": "整套连续演讲稿。用【1】【2】...【N】标记每页，段落之间自然衔接。",
    "deck_storyline": "整套演讲的一句话主线",
    "slides": [
        {{
            "slide_index": 1,
            "title": "页面主标题",
            "page_type": "cover/catalog/content/end",
            "key_points": ["核心要点1", "关键数据2"],
            "suggested_script": "本页演讲稿（与full_script对应段落一致）",
            "speaking_tips": "具体的手势/语调/停顿建议，引用本页名词/数字",
            "transition_hint": "用问题或悬念引向下一页",
            "interaction_points": ["与本页内容相关的互动点"],
            "estimated_duration_sec": 60
        }}
    ],
    "suggestions": ["基于全文的具体改进建议1", "建议2", "建议3"],
    "overall_structure": "整体结构评价",
    "scores": {{
        "structure": 0-100,
        "logic": 0-100,
        "content": 0-100,
        "total": 0-100
    }}
}}

只返回 JSON。"""

        try:
            response = await asyncio.to_thread(
                client.chat.completions.create,
                model="glm-4v-flash",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "file_url",
                                "file_url": {
                                    "url": f"data:{mime_type};base64,{file_b64}"
                                }
                            },
                            {
                                "type": "text",
                                "text": prompt
                            }
                        ]
                    }
                ]
            )
            
            content = response.choices[0].message.content
            parsed = _extract_json_payload(content)
            
            if isinstance(parsed, dict):
                parsed.setdefault("full_script", "")
                parsed.setdefault("deck_storyline", "")
                parsed.setdefault("slides", [])
                parsed.setdefault("suggestions", [])
                parsed.setdefault("overall_structure", "")
                parsed.setdefault("scores", {"total": 78, "structure": 78, "logic": 78, "content": 78})
                return parsed
            
            return {"error": "Invalid response format", "slides": []}
            
        except Exception as e:
            print(f"Document analysis failed: {e}")
            return {"error": str(e), "slides": []}


async def analyze_slide_content(
    image_path: str,
    previous_context: str = "",
    *,
    slide_index: Optional[int] = None,
    total_slides: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Analyze PPT slide content to generate speech script
    
    Returns:
        {
            "title": "Slide title if detected",
            "key_points": ["point1", "point2", ...],
            "suggested_script": "Full suggested speech script for this slide",
            "speaking_tips": "讲解技巧与注意事项",
            "transition_hint": "与下一页的过渡语建议",
            "interaction_points": ["可设置的互动点"],
            "estimated_duration_sec": 60,
            "summary_for_next_slide": "Context for next slide"
        }
    """
    async with _glm_semaphore:
        client = get_client()
        
        image_b64 = image_to_base64(image_path)
        
        context_block = ""
        if previous_context:
            context_block = f"\n\n**上一页核心结论**（请基于此生成自然的过渡语）：\n{previous_context}"

        deck_pos = ""
        if slide_index is not None and total_slides is not None:
            deck_pos = f"\n\n你正在处理第 {int(slide_index)}/{int(total_slides)} 页。请确保整套PPT讲起来是一条连续叙事：术语一致、逻辑连贯、过渡自然。"
        
        response = await asyncio.to_thread(
            client.chat.completions.create,
            model="glm-4v-flash",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_b64}"
                            }
                        },
                        {
                            "type": "text",
                            "text": f"""你是为TED演讲者、商业高管服务的顶级演讲教练。请根据这张PPT页面，生成**专业级别、个性化**的演讲辅导内容。{context_block}{deck_pos}

## 第一步：准确判断页面类型

1. **封面页**（主标题+演讲者/日期）→ 生成开场白（可问候，但要简洁有力）
2. **目录页**（章节列表）→ 预告结构，如"今天我会从三个维度展开..."
3. **内容页**（正文/图表/数据/代码）→ **严禁任何问候语！直接讲干货！**
4. **结尾页**（总结/致谢/Q&A）→ 总结要点+致谢

## 第二步：生成演讲稿 (suggested_script) —— 最重要！

### 绝对禁止（违反即失败）：
❌ 内容页以"大家好"、"各位同学"、"欢迎来到"开头
❌ 使用"如图所示"、"我们可以看到"、"众所周知"、"这一页讲的是..."
❌ 每页都用"首先/其次/最后"作为分点开头
❌ 空泛描述内容，不提具体名词/数据/术语

### 必须做到：
✅ **以本页最核心的"结论/数据/关键词"开场**
✅ **提取页面上的具体内容**：数据、名词、公式、代码片段必须在稿中出现
✅ **有清晰的逻辑层次**：先结论后细节，或先问题后方案
✅ **自然口语化**：像在和朋友解释一个有趣的问题

## 第三步：生成讲解技巧 (speaking_tips) —— 必须超具体！

### 绝对禁止（这些太空泛/模板化）：
❌ "可以做一个手势来表示..."、"可以用手势指向屏幕..."
❌ "可以稍微停顿一下"、"可以加重语气"、"适当放慢语速"
❌ "表达清晰"、"注意语速"、"语言简洁"
❌ 任何不引用本页**具体名词/数字/术语**的建议

### 正确格式——必须是"讲到[具体内容]时，做[具体动作]"：
✅ 讲到"MVVM架构"时，左手代表View、右手代表ViewModel，两手相对表示双向绑定
✅ 读到"@State rememberPassword"这行代码时，停顿1秒，让听众看清变量名
✅ 说"异步handleLogin"时，用手画一个循环的手势，表示等待回调
✅ 提到"验证码60秒倒计时"时，可以真的默数"3、2、1"来模拟等待的焦虑感

## 第四步：生成过渡建议 (transition_hint) —— 必须自然！

### 绝对禁止（这些太机械/模板化）：
❌ "我们已经了解了...，那么接下来..."
❌ "下一页将深入探讨..."、"接下来我们会介绍..."
❌ "那么接下来我们就来看看..."
❌ "我们将继续探讨..."、"让我们看看如何..."

### 正确格式——用问题/悬念/因果关系引出下一页：
✅ "架构讲完了，代码长什么样？"（问题）
✅ "设计图有了，用户实际操作起来呢？"（悬念）
✅ "既然状态管理这么重要，那登录逻辑怎么写？"（因果）
✅ "注册搞定了，登录就简单了——其实不然。"（转折）

## 第五步：设计互动点 (interaction_points) —— 要与本页内容强相关！

### 绝对禁止：
❌ 每页都写"请问大家..."、"大家有没有..."这种模板
❌ 与页面内容无关的通用互动

### 正确格式——从本页内容引出：
✅ 页面讲 MVVM → "用过 Vue/React 的同学应该很熟悉这个模式"
✅ 页面讲验证码 → "手机上收验证码最长等过多久？超过60秒就想骂人了对吧"
✅ 页面讲密码强度 → "你们平时设密码，会用生日还是随机字符？"

## 输出前自检（必须遵守！）

在输出JSON前，你必须检查：
1. speaking_tips 是否包含本页的具体术语/数字？（如果没有，必须重写！）
2. transition_hint 是否包含"我们已经了解了"/"接下来我们"？（如果有，必须删除重写！）
3. suggested_script 开头是否是"大家好"/"今天"？（内容页严禁！）

请返回严格 JSON（只返回 JSON，无其他内容）：
{{{{
    "title": "准确提取的页面主标题",
    "page_type": "cover/catalog/content/end",
    "key_points": ["核心要点1（具体名词/数据）", "要点2"],
    "suggested_script": "80-180字演讲稿。内容页必须以核心内容开场！",
    "speaking_tips": "格式必须是：讲到'XXX'时，做YYY。XXX必须是本页的具体术语！",
    "transition_hint": "必须是问句或悬念句。禁止'我们已经...'句式！例如：架构清楚了，代码呢？",
    "interaction_points": ["从本页内容引出的问题，不要用'请问大家'开头"],
    "estimated_duration_sec": 60,
    "summary_for_next_slide": "本页一句话核心结论"
}}}}

只返回 JSON。"""
                        }
                    ]
                }
            ]
        )
        
        content = response.choices[0].message.content
        
        try:
            parsed = _extract_json_payload(content)
            if isinstance(parsed, dict):
                parsed.setdefault("title", "")
                parsed.setdefault("page_type", "content")
                parsed.setdefault("key_points", [])
                parsed.setdefault("suggested_script", "")
                parsed.setdefault("speaking_tips", "")
                parsed.setdefault("transition_hint", "")
                parsed.setdefault("interaction_points", [])
                parsed.setdefault("estimated_duration_sec", 60)
                parsed.setdefault("summary_for_next_slide", "")

                # Normalize arrays
                kps = parsed.get("key_points")
                if not isinstance(kps, list):
                    kps = []
                kps = [str(x).strip() for x in kps if str(x).strip()]
                parsed["key_points"] = kps[:8]

                # Ensure non-empty core narrative fields (avoid blank UI/export)
                title = str(parsed.get("title") or "").strip()
                page_type = str(parsed.get("page_type") or "content").strip() or "content"
                suggested = str(parsed.get("suggested_script") or "").strip()
                tips = str(parsed.get("speaking_tips") or "").strip()
                transition = str(parsed.get("transition_hint") or "").strip()
                summary = str(parsed.get("summary_for_next_slide") or "").strip()

                def _strip_greetings_local(text: str) -> str:
                    t = str(text or "").strip()
                    if not t:
                        return ""
                    import re

                    # Allow leading quotes/brackets then remove common greetings/openers.
                    prefix = r"^[\s\"'“”‘’\(\[（【]*"
                    t2 = re.sub(
                        prefix
                        + r"(?:大家好|各位好|各位同学们好|同学们好|老师好|各位老师好|各位评委好|各位评委老师好)"
                        + r"[，,。\.\s]*",
                        "",
                        t,
                    )
                    # Remove common welcome/return-to-talk style openers.
                    t2 = re.sub(
                        prefix
                        + r"(?:欢迎|很高兴|非常高兴)(?:大家)?\s*(?:回到|来到|参加|收看|观看|参与)?[\u4e00-\u9fa5\w\s]{0,18}"
                        + r"[，,。\.\s]*",
                        "",
                        t2,
                    )
                    return t2.strip(" \t\r\n\"'“”‘’）】")

                # Avoid repetitive enumerator starters for content pages; prefer keyword-first phrasing.
                if page_type == "content" and suggested.startswith(("首先", "其次", "最后")):
                    suggested = suggested.lstrip("首先其次最后：:，。 ")

                if not suggested:
                    if title and kps:
                        suggested = f"这一页的核心是：{title}。你可以抓住两点：{kps[0]}" + (f"；{kps[1]}" if len(kps) > 1 else "") + "。"
                    elif kps:
                        suggested = f"这一页重点有两点：{kps[0]}" + (f"；{kps[1]}" if len(kps) > 1 else "") + "。"
                    else:
                        suggested = "这一页我先用一句话讲清核心结论，再用 2-3 个要点支撑，最后留一句话引到下一页。"
                
                # ========== 强力后处理：修复模板化内容 ==========
                
                # 1. 修复过渡建议（transition_hint）
                # 检测禁止句式并替换为更自然的问句
                bad_transition_patterns = [
                    "我们已经了解了", "接下来我们", "那么接下来", "下一页将",
                    "让我们看看", "我们将继续", "我们将探讨", "我们将深入",
                    "接下来会", "下面我们", "现在让我们", "讲完了，接下来呢",
                ]
                transition_is_bad = any(p in transition for p in bad_transition_patterns) or not transition.strip()
                if transition_is_bad:
                    # 根据本页内容生成更自然的问句式过渡
                    transition_templates = [
                        "到这里，{key}的'是什么'已经清楚了——接下来的关键是'怎么做'。",
                        "{key}交代完了，它实际运行起来效果如何？",
                        "理论讲到这里，我们来看一个具体的例子：",
                        "明白了{key}的原理后，实际应用会遇到什么挑战？",
                        "刚才是概念层面，现在深入到技术细节——",
                    ]
                    import random
                    template = random.choice(transition_templates)
                    key = (kps[0][:12] if kps else title[:12] if title else "核心概念")
                    transition = template.format(key=key)
                
                # 2. 修复讲解技巧（speaking_tips）
                # 如果是列表格式，转为字符串
                if isinstance(tips, list):
                    tips = "；".join(str(t).strip() for t in tips if str(t).strip())
                
                # 检测空洞描述
                bad_tips_patterns = [
                    "可以做一个手势", "可以用手势", "可以适当", "可以稍微",
                    "表达清晰", "注意语速", "加重语气", "放慢语速",
                    "做一个手势来表示", "通过手势来", "展示一下",
                    "可以展示", "可以通过", "画一个", "比出一个",
                    "拇指和食指", "掌心向上", "双手张开", "轻轻点头",
                    "挥动双手", "拍手表示", "做一个展示", "做出一个",
                ]
                tips_is_bad = any(p in tips for p in bad_tips_patterns)
                if tips_is_bad and (kps or title):
                    # 根据本页具体内容重新生成
                    if kps and len(kps) >= 1:
                        first_kp = str(kps[0])[:20]  # 截取前20字符
                        if len(kps) >= 2:
                            second_kp = str(kps[1])[:20]
                            tips = f"讲到'{first_kp}'时停顿1秒让听众记住；说到'{second_kp}'时语调上扬形成对比"
                        else:
                            tips = f"讲到'{first_kp}'时停顿1秒，让这个关键词在听众脑中扎根"
                    elif title:
                        tips = f"讲到'{title[:20]}'时放慢语速，每个字清晰有力"
                
                # 3. 修复演讲稿开头（对于目录页，不要念目录）
                if page_type == "catalog":
                    # 目录页不应该逐个念条目，应该预告结构
                    if "今天我将为大家" in suggested or "本次研究" in suggested or "首先是" in suggested:
                        if kps:
                            suggested = f"今天的核心是{len(kps)}件事：{'、'.join(kps[:3])}。先看第一个。"
                
                # 4. 修复互动点（interaction_points）
                ips = parsed.get("interaction_points", [])
                if isinstance(ips, list):
                    cleaned_ips = []
                    for ip in ips:
                        ip_str = str(ip).strip()
                        # 去掉"请问大家"等模板开头
                        if ip_str.startswith(("请问大家", "大家有没有", "请问在座")):
                            ip_str = ip_str.replace("请问大家", "").replace("大家有没有", "").replace("请问在座", "")
                            ip_str = ip_str.lstrip("，,：: ")
                            if ip_str:
                                ip_str = ip_str[0].upper() + ip_str[1:] if len(ip_str) > 1 else ip_str
                        cleaned_ips.append(ip_str)
                    parsed["interaction_points"] = cleaned_ips
                
                # ========== 后处理结束 ==========
                
                if not tips:
                    tips = "读到关键名词/数字时放慢语速并停顿 0.5-1 秒；用手势指向屏幕对应位置，避免空泛描述。"
                if not transition:
                    transition = "把本页结论收束成一句话后，顺势抛出一个问题引向下一页：‘那么接下来怎么做/结果如何？’"
                if not summary:
                    summary = kps[0] if kps else (title or "本页核心结论")

                parsed["page_type"] = page_type
                parsed["title"] = title
                # Enforce: only cover page may contain greetings/openers.
                if str(page_type).strip().lower() != "cover":
                    suggested = _strip_greetings_local(suggested)
                parsed["suggested_script"] = suggested
                parsed["speaking_tips"] = tips
                parsed["transition_hint"] = transition
                parsed["summary_for_next_slide"] = summary
                return parsed
        except Exception as e:
            print(f"[GLM] JSON parse error: {e}, content: {content[:200]}...")

        return {
            "title": "页面分析",
            "page_type": "content",
            "key_points": [],
            "suggested_script": "（本页AI解析失败）建议用‘一句话结论 + 2-3个要点 + 下一页引子’快速讲清，并优先参考PPT备注。",
            "speaking_tips": "讲到关键名词/数字时放慢语速并停顿 0.5-1 秒；用手势指向屏幕对应位置。",
            "transition_hint": "先收束本页结论，再自然引出下一页。",
            "interaction_points": [],
            "estimated_duration_sec": 60,
            "summary_for_next_slide": "",
        }


async def analyze_speaker_frame(image_path: str) -> Dict[str, Any]:
    """
    Analyze speaker's expression and posture from a video frame
    
    Returns:
        {
            "confidence_score": 0-100,
            "expression": "confident/nervous/neutral/enthusiastic",
            "posture": "open/closed/neutral",
            "gesture_quality": "appropriate/excessive/insufficient",
            "eye_contact": "good/poor/partial",
            "issues": ["issue1", "issue2"],
            "highlights": ["highlight1"],
            "summary": "Brief description of the speaker's presentation"
        }
    """
    async with _glm_semaphore:
        client = get_client()
        
        image_b64 = image_to_base64(image_path)
        
        response = await asyncio.to_thread(
            client.chat.completions.create,
            model="glm-4v-flash",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_b64}"
                            }
                        },
                        {
                            "type": "text",
                            "text": """你是专业演讲教练。请分析这张演讲者截图，输出**具体、可验证**的观察结论。

硬性要求：
- 不要输出空泛词（如“表情很好/姿态不错/状态一般”）。必须写出**具体特征**（例如：是否微笑、眉眼紧张、下颌抬/低、肩部是否外展、双手是否可见并做了什么动作、视线是否看镜头、身体是否前倾等）。
- highlights 最多 1 条；issues 最多 1 条；如果没有明显亮点/问题，可以返回空数组。
- summary 1-2 句，概括本帧最重要的结论。

请返回严格 JSON（只返回 JSON）：
{
  "confidence_score": 0-100,
  "expression": "confident|nervous|neutral|enthusiastic",
  "posture": "open|closed|neutral",
  "gesture_quality": "appropriate|excessive|insufficient",
  "eye_contact": "good|poor|partial",
  "highlights": ["一条具体亮点（可为空）"],
  "issues": ["一条具体问题（可为空）"],
  "summary": "一句话总结"
}
"""
                        }
                    ]
                }
            ]
        )
        
        content = response.choices[0].message.content
        
        # Parse JSON from response
        import json
        try:
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            parsed = json.loads(content.strip())
            if isinstance(parsed, dict):
                parsed.setdefault("confidence_score", 50)
                parsed.setdefault("expression", "neutral")
                parsed.setdefault("posture", "neutral")
                parsed.setdefault("gesture_quality", "appropriate")
                parsed.setdefault("eye_contact", "partial")
                parsed.setdefault("issues", [])
                parsed.setdefault("highlights", [])
                parsed.setdefault("summary", "")
                return parsed
            return {
                "confidence_score": 50,
                "expression": "neutral",
                "posture": "neutral",
                "gesture_quality": "appropriate",
                "eye_contact": "partial",
                "issues": [],
                "highlights": [],
                "summary": content,
            }
        except:
            return {
                "confidence_score": 50,
                "expression": "neutral",
                "posture": "neutral",
                "gesture_quality": "appropriate",
                "eye_contact": "partial",
                "issues": [],
                "highlights": [],
                "summary": content
            }

async def generate_improvement_suggestions(events: List[Dict], metrics: Dict) -> List[str]:
    """
    Generate personalized improvement suggestions based on practice data
    
    Args:
        events: List of issue events from the session
        metrics: Summary metrics (avg_speed, filler_count, etc.)
    
    Returns:
        List of 3 specific improvement suggestions
    """
    async with _glm_semaphore:
        client = get_client()
        
        # Prepare context (aggregate + representative evidence)
        issue_counts: Dict[str, int] = {}
        examples_by_cat: Dict[str, List[Dict[str, Any]]] = {}
        for e in events or []:
            if e.get("type") != "issue":
                continue
            cat = e.get("category") or "other"
            issue_counts[cat] = issue_counts.get(cat, 0) + 1
            examples_by_cat.setdefault(cat, [])
            if len(examples_by_cat[cat]) < 2:
                examples_by_cat[cat].append({
                    "start_ms": e.get("start_ms"),
                    "end_ms": e.get("end_ms"),
                    "evidence": e.get("evidence", {}),
                })

        top_cats = sorted(issue_counts.items(), key=lambda x: -x[1])[:5]
        top_summary = []
        for cat, cnt in top_cats:
            top_summary.append({
                "category": cat,
                "count": cnt,
                "examples": examples_by_cat.get(cat, [])
            })

        prompt = f"""你是资深演讲教练。请基于这次练习的客观数据，生成 3 条“最有杠杆”的改进建议。

输出要求（非常重要）：
1) 每条建议必须包含：问题判断 + 本次证据 + 训练方法 + 可量化目标
2) 不要千篇一律的套话；不要建议做会变差的行为。
3) 建议必须可执行，给出具体练法（例如：计时器、刻意停顿、镜头注视点、手势节奏、结构话术）。
4) 建议要和问题强相关：优先覆盖 top 问题类别。

本次统计指标：
- 平均语速: {metrics.get('avg_speed', 'N/A')} 字/分钟
- 口头禅次数: {metrics.get('filler_count', 0)}
- 低头次数: {metrics.get('head_down_count', 0)}
- 总时长: {metrics.get('duration_sec', 0)} 秒

事件分布（含示例证据）：
{top_summary if top_summary else '[]'}

请返回严格 JSON 数组，共 3 条字符串，每条建议建议采用如下格式：
"【主题】一句话结论（证据：...）。训练法：...。目标：..."

只返回 JSON 数组，不要其他内容。"""

        response = await asyncio.to_thread(
            client.chat.completions.create,
            model="glm-4v-flash",
            messages=[{"role": "user", "content": prompt}]
        )
        
        content = response.choices[0].message.content
        
        import json
        try:
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            suggestions = json.loads(content.strip())
            if isinstance(suggestions, list):
                return suggestions[:3]
        except:
            pass
        
        # Fallback: generate data-driven suggestions based on actual metrics
        fallback = []
        
        # Speech speed analysis
        avg_speed = metrics.get('avg_speed', 0)
        if avg_speed and avg_speed > 240:
            fallback.append(f"调整语速至平均语速范围（当前 {avg_speed} 字/分钟偏快）。建议使用计时器朗读练习，目标控制在 160-240 字/分钟。")
        elif avg_speed and avg_speed < 160 and avg_speed > 0:
            fallback.append(f"适当加快语速（当前 {avg_speed} 字/分钟偏慢）。过慢的语速可能导致听众注意力分散，建议保持在 160-240 字/分钟。")
        else:
            fallback.append("语速控制良好，继续保持。可以在重点内容处适当放慢语速以增强效果。")
        
        # Filler words analysis
        filler_count = metrics.get('filler_count', 0)
        if filler_count > 10:
            fallback.append(f"减少口头禅使用（本次共 {filler_count} 次）。训练方法：每次想说'嗯''啊'时，改为短暂停顿 1-2 秒，让听众有思考时间。")
        elif filler_count > 5:
            fallback.append(f"口头禅次数（{filler_count} 次）在可接受范围，但仍可优化。建议录制练习并回听，识别自己的口头禅习惯。")
        else:
            fallback.append("口头禅控制良好，语言表达流畅。")
        
        # Head/eye contact analysis
        head_down = metrics.get('head_down_count', 0)
        look_away = metrics.get('look_away_count', 0)
        if head_down > 3 or look_away > 3:
            fallback.append(f"改善眼神接触（低头 {head_down} 次，视线偏离 {look_away} 次）。建议：在摄像头旁贴一个小标记作为注视点，练习时有意识地看向标记。")
        else:
            fallback.append("眼神接触保持良好，表现自然自信。可以尝试在强调重点时做短暂的停顿配合眼神。")
        
        return fallback[:3]

async def generate_speaker_profile(history_data: List[Dict]) -> Dict[str, Any]:
    """
    Generate speaker profile based on historical practice data
    
    Returns:
        {
            "style_tags": ["逻辑清晰型", "..."],
            "common_issues": [{"issue": "...", "frequency": 10}],
            "strengths": ["..."],
            "weekly_focus": "本周建议重点..."
        }
    """
    async with _glm_semaphore:
        client = get_client()
        
        # Summarize history
        history_summary = []
        for h in history_data[-10:]:  # Last 10 sessions
            history_summary.append({
                "date": h.get("created_at", ""),
                "score": h.get("total_score", 0),
                "issues": h.get("issue_categories", [])
            })
        
        prompt = f"""基于以下演讲者的历史练习数据，生成演讲者画像：

历史数据：
{history_summary}

请返回JSON格式：
{{
    "style_tags": ["风格标签1", "风格标签2"],
    "common_issues": [{{"issue": "问题描述", "frequency": 5}}],
    "strengths": ["优势1", "优势2"],
    "weekly_focus": "本周建议重点训练..."
}}

只返回JSON，不要其他内容"""

        response = await asyncio.to_thread(
            client.chat.completions.create,
            model="glm-4v-flash",
            messages=[{"role": "user", "content": prompt}]
        )
        
        content = response.choices[0].message.content
        
        import json
        try:
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            return json.loads(content.strip())
        except:
            return {
                "style_tags": ["成长中"],
                "common_issues": [],
                "strengths": [],
                "weekly_focus": "继续保持练习"
            }


async def generate_ppt_prep_report(slides_info: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Generate a prep-only report for PPT analysis mode (no recording).

    Returns:
        {
          "outline": [{"slide_index": 1, "title": "...", "key_points": [...] }],
          "suggestions": ["...", "...", "..."],
          "scores": {"total": 80, "structure": 82, "logic": 78, "content": 80},
          "estimated_total_duration_sec": 123
        }
    """
    async with _glm_semaphore:
        client = get_client()

        def _pick_keyword(title: str, key_points: Any) -> str:
            t = str(title or "").strip()
            if t:
                return t
            if isinstance(key_points, list):
                for kp in key_points:
                    s = str(kp or "").strip()
                    if s:
                        return s
            return "本页要点"

        def _looks_templated_transition(text: str) -> bool:
            t = str(text or "").strip()
            if not t:
                return True
            bad = [
                "下一页将",
                "下一个幻灯片",
                "接下来我们会",
                "接下来我们将",
                "我们将进入",
                "下面我们将",
                "我们已经了解了",
                "在上页介绍了",
                "在上一页",
                "现在让我们进入",
                "现在我们进入",
                "现在我们来看看",
            ]
            return any(b in t for b in bad)

        def _looks_generic_tips(text: str) -> bool:
            t = str(text or "").strip()
            if not t:
                return True
            bad = [
                "表达清晰",
                "注意语速",
                "语言简洁",
                "清晰简洁",
                "突出关键词",
                "突出关键",
                "适当做手势",
                "用手势来强调",
                "吸引观众的注意",
                "保持自信",
                "尽量",
                "适当",
            ]
            # Too short + contains generic phrasing
            return (len(t) < 18 and any(b in t for b in bad)) or (any(b in t for b in bad) and len(t) < 30)

        def _strip_greetings(text: str) -> str:
            t = str(text or "").strip()
            if not t:
                return ""
            # Remove leading greetings/opening only (keep rest)
            import re
            prefix = r"^[\s\"'“”‘’\(\[（【]*"
            t2 = re.sub(
                prefix
                + r"(?:大家好|各位好|各位同学们好|同学们好|老师好|各位老师好|各位评委好|各位评委老师好)"
                + r"[，,。\.\s]*",
                "",
                t,
            )
            # Also remove common welcome/return-to-talk openers (e.g. “欢迎回到我们的演讲…”)
            t2 = re.sub(
                prefix
                + r"(?:欢迎|很高兴|非常高兴)(?:大家)?\s*(?:回到|来到|参加|收看|观看|参与)?[\u4e00-\u9fa5\w\s]{0,18}"
                + r"[，,。\.\s]*",
                "",
                t2,
            )
            return t2.strip(" \t\r\n\"'“”‘’）】")

        def _derive_transition(cur_key: str, next_key: str, slide_index: int) -> str:
            patterns = [
                "把“{cur}”先收束成一句结论，然后顺着‘为什么/怎么做/结果如何’把话题带到“{nxt}”。",
                "到这里我们已经把“{cur}”讲清楚了；接下来关键是“{nxt}”，看它如何支撑整体结论。",
                "“{cur}”回答了‘是什么’，下一步要回答‘怎么做’——进入“{nxt}”。",
                "基于“{cur}”这个结论，我们自然会问：下一步怎么推进？这就引出“{nxt}”。",
            ]
            p = patterns[max(0, int(slide_index or 1) - 1) % len(patterns)]
            return p.format(cur=cur_key, nxt=next_key)

        def _derive_speaking_tips(cur_key: str, key_points: Any, slide_index: int) -> str:
            import re

            blob = " ".join([str(cur_key or "")] + [str(x or "") for x in (key_points if isinstance(key_points, list) else [])])
            m = re.search(r"(\d+\.?\d*)", blob)
            if m:
                num = m.group(1)
                return f"讲到“{num}”时放慢语速并停顿 0.5-1 秒，用手指或手势把数字‘亮出来’；句末用一句话把“{cur_key}”收束。"

            if any(k in blob for k in ["对比", "比较", "优劣", "优势", "差异", "冲突"]):
                return f"讲“{cur_key}”时用左右手做对比：左手代表A、右手代表B；每说完一边停顿 0.3-0.5 秒，让听众跟上。"

            if any(k in blob for k in ["流程", "步骤", "机制", "算法", "方法", "框架", "策略"]):
                return f"把“{cur_key}”拆成 2-3 步讲：每一步用手指点一下（1/2/3），关键术语出现时稍微加重语气并停顿。"

            return f"用“{cur_key}”这个关键词开场，先给结论再补 1-2 个支撑点；每个要点讲完停顿一下，避免一口气念完。"

        def _default_storyline_from_outline(items: list[dict[str, Any]]) -> tuple[str, str]:
            titles = [str(o.get("title") or "").strip() for o in items if isinstance(o, dict)]
            titles = [t for t in titles if t]
            if len(titles) >= 2:
                deck_storyline = f"从“{titles[0]}”引入主题，逐步展开关键论证，最后在“{titles[-1]}”收束并给出结论/行动。"
                overall_structure = "整体建议按“问题/背景→方法/方案→结果/价值→总结/下一步”的节奏串起来；每页开头用本页关键词起手，页与页之间用一句承接过渡。"
                return overall_structure, deck_storyline
            if len(titles) == 1:
                deck_storyline = f"围绕“{titles[0]}”展开：先给出结论，再用要点与证据支撑，最后收束并给出下一步。"
                overall_structure = "建议补齐整体叙事链路：开场价值预告→核心论点→证据/案例→总结与行动号召。"
                return overall_structure, deck_storyline
            return (
                "建议补齐整体叙事链路：开场价值预告→核心论点→证据/案例→总结与行动号召，并为每页准备一句自然过渡。",
                "从问题出发，给出方案与证据，最后总结并提出下一步。",
            )

        outline = []
        total_est = 0
        for s in slides_info:
            analysis = (s.get("analysis") or {}) if isinstance(s, dict) else {}
            title = analysis.get("title") or ""
            key_points = analysis.get("key_points") or []
            speaking_tips = analysis.get("speaking_tips") or ""
            transition_hint = analysis.get("transition_hint") or ""
            interaction_points = analysis.get("interaction_points") or []
            suggested_script = analysis.get("suggested_script") or ""
            est = int(analysis.get("estimated_duration_sec") or 0)
            total_est += max(0, est)
            outline.append({
                "slide_index": s.get("index"),
                "title": title,
                "key_points": key_points[:5],
                "speaking_tips": speaking_tips,
                "transition_hint": transition_hint,
                "interaction_points": interaction_points[:3],
                "suggested_script": suggested_script,
                "talk_track": "",
                "estimated_duration_sec": est or None,
            })

        slide_indices: List[int] = []
        for o in outline:
            try:
                if isinstance(o, dict) and o.get("slide_index") is not None:
                    slide_indices.append(int(o.get("slide_index")))
            except Exception:
                continue
        slide_indices = sorted(set(slide_indices))

        prompt = f"""你是为TED演讲者和商业高管服务的顶级演讲教练。请基于以下PPT每页内容摘要，生成一套**完整、连贯、专业**的演讲备稿方案。

## 核心任务：生成"像讲故事一样"的连续演讲稿

你的首要任务是生成 full_script —— 这是整套PPT的完整演讲稿。要求：

### 1. 必须像"一个完整故事"：
- 从封面页到结尾页，要有**清晰的叙事脉络**（如：问题→方案→证据→结论）
- 每页之间必须有**自然的逻辑衔接**，而非孤立的段落
- 听众应该能感受到"这是一个有明确起承转合的演讲"

### 2. 每页段落的写作要求：

❌ **绝对禁止**：
- 每页都用"首先/其次/最后"、"这一页讲的是"、"接下来我们看"开头
- 使用"如图所示"、"我们可以看到"、"众所周知"等模板句
- 内容页出现"大家好"、"各位同学"等问候语（仅封面页可用简短问候）

✅ **必须做到**：
- 以**本页最核心的名词/数据/结论**作为段落开头
- 每页段落末尾用**问题或悬念**自然引向下一页
- 整体读起来像在"和朋友解释一个有趣的项目"

### 3. 正确示范（请模仿这种风格）：

【1】（封面页）
大家好，今天我要分享的是：如何让机器人在599米高的摩天大楼里高效送餐。这听起来像科幻电影，但它正发生在深圳平安金融中心——全球第四高楼。

【2】（目录页）
我会从三个层面来讲：这个问题到底有多难、我们设计了什么算法、结果符不符合预期。先从问题规模开始。

【3】（内容页-问题背景）
深圳平安金融中心：118层，日均服务2万人。但午高峰时段，仅有2部专用电梯可供配送机器人使用——这就是瓶颈所在。那么，如何设计一套智能调度系统来破局？

【4】（内容页-方法）
ALNS算法的核心只有两个字：破坏。先随机移除20-30%的任务分配，再用贪心策略逐个插回找到更优解。通过500次迭代，逐步逼近全局最优。接下来看实验结果。

【5】（结尾页）
总结三点：问题是电梯瓶颈、方法是ALNS智能调度、效果是比贪心快30%且更省电。如果你对多智能体调度感兴趣，欢迎会后交流。谢谢！

---

## 输出格式（严格JSON）

{{
    "full_script": "整套连续演讲总稿（800-2000字）。用【1】【2】...【N】标记每页。每页一段，段落之间自然衔接。",
    "slide_scripts": [
        {{"slide_index": 1, "suggested_script": "从full_script中截取的第1页内容（与full_script保持一致）"}}
    ],
    "suggestions": [
        "基于这套PPT的具体改进建议1（引用具体页码或内容）",
        "改进建议2",
        "改进建议3",
        "改进建议4",
        "改进建议5"
    ],
    "overall_structure": "整体结构评价（评估开场-展开-收束是否完整，衔接是否自然）",
    "deck_storyline": "整套演讲的一句话主线（如：从问题出发，展示方案与证据，最终证明价值）",
    "scores": {{
        "structure": 0-100,
        "logic": 0-100,
        "content": 0-100,
        "total": 0-100
    }},
    "improvement_areas": ["需要重点提升的方面1", "方面2"],
    "slide_refinements": [
        {{
            "slide_index": 1,
            "section": "章节归属（开场/背景/方法/实验/总结等）",
            "role": "本页在整套演讲中的作用",
            "talk_track": "本页1-2句核心讲述思路（必须包含本页关键词）",
            "transition_hint": "到下一页的自然过渡（用问题/悬念，不要用'接下来我们将...'）",
            "speaking_tips": "本页具体的演讲动作（引用页面内容，如：讲到'2部电梯'时伸出两指强调）"
        }}
    ]
}}

## PPT 内容摘要（共{len(outline)}页）：
{outline}

## 输出要求：
- slide_scripts 必须覆盖所有页码：{slide_indices}
- slide_refinements 必须覆盖所有页码：{slide_indices}
- full_script 的每页段落必须以"本页关键词/数据"开场，避免模板化开头
- speaking_tips 必须引用本页的具体名词/数字，不要写"注意语速"等空泛建议
- transition_hint 必须用问题或悬念引向下一页，不要写"下一页将讲..."
- 评分要客观，不要虚高；存在明显问题时给出真实分数

只返回 JSON，无其他内容。
"""


        response = await asyncio.to_thread(
            client.chat.completions.create,
            model="glm-4v-flash",
            messages=[{"role": "user", "content": prompt}],
        )

        content = response.choices[0].message.content
        try:
            parsed = _extract_json_payload(content)
            if isinstance(parsed, dict):
                parsed.setdefault("outline", outline)
                parsed.setdefault("estimated_total_duration_sec", total_est or None)
                parsed.setdefault("suggestions", [])
                parsed.setdefault("improvement_areas", [])
                parsed.setdefault("overall_structure", "")
                parsed.setdefault("deck_storyline", "")
                parsed.setdefault("full_script", "")
                parsed.setdefault("slide_scripts", [])
                # Ensure scores exist
                if "scores" not in parsed:
                    parsed["scores"] = {"total": 78, "structure": 78, "logic": 78, "content": 78}

                if not isinstance(parsed.get("suggestions"), list):
                    parsed["suggestions"] = []
                parsed["suggestions"] = [str(x).strip() for x in (parsed.get("suggestions") or []) if str(x).strip()]
                if len(parsed["suggestions"]) == 0:
                    parsed["suggestions"] = [
                        "为每页之间准备一句过渡语：用‘收束本页结论→抛出问题→引出下一页’三段式。",
                        "每页开头用本页关键词/数字起手，避免‘如图所示/我们可以看到/首先’等模板句。",
                        "关键数据出现时放慢语速并停顿 0.5-1 秒，让听众记住数字与结论。",
                        "目录页明确‘我将从三点展开’，结尾页用‘总结三点+下一步/行动号召’收束。",
                    ]

                if not isinstance(parsed.get("improvement_areas"), list):
                    parsed["improvement_areas"] = []
                parsed["improvement_areas"] = [str(x).strip() for x in (parsed.get("improvement_areas") or []) if str(x).strip()]
                if len(parsed["improvement_areas"]) == 0:
                    parsed["improvement_areas"] = ["整体衔接", "证据密度", "过渡自然度"]

                # Prefer the sliced-from-deck scripts for per-slide suggested_script to improve coherence.
                slide_scripts = parsed.get("slide_scripts")
                slide_script_by_idx: Dict[int, str] = {}
                if isinstance(slide_scripts, list):
                    for item in slide_scripts:
                        if not isinstance(item, dict):
                            continue
                        try:
                            idx_i = int(item.get("slide_index"))
                        except Exception:
                            continue
                        text = str(item.get("suggested_script") or "").strip()
                        if text:
                            slide_script_by_idx[idx_i] = text

                # If slide_scripts is missing/incomplete, try parsing full_script markers like 【1】...【N】.
                full_script = str(parsed.get("full_script") or "").strip()
                if full_script:
                    import re

                    marker_re = re.compile(
                        r"(?:【|\[|\(|（)\s*(?:第\s*)?(\d+)\s*(?:页)?\s*(?:】|\]|\)|）)",
                        re.MULTILINE,
                    )
                    matches = list(marker_re.finditer(full_script))
                    if matches:
                        for mi, m in enumerate(matches):
                            try:
                                idx_i = int(m.group(1))
                            except Exception:
                                continue
                            start = m.end()
                            end = matches[mi + 1].start() if mi + 1 < len(matches) else len(full_script)
                            chunk = full_script[start:end].strip()
                            if chunk and idx_i not in slide_script_by_idx:
                                slide_script_by_idx[idx_i] = chunk

                overall_structure = str(parsed.get("overall_structure") or "").strip()
                deck_storyline = str(parsed.get("deck_storyline") or "").strip()
                if not overall_structure or not deck_storyline:
                    os2, ds2 = _default_storyline_from_outline(outline)
                    if not overall_structure:
                        parsed["overall_structure"] = os2
                    if not deck_storyline:
                        parsed["deck_storyline"] = ds2

                # Apply per-slide refinements back onto outline for better on-screen coherence.
                ref = parsed.get("slide_refinements")
                if isinstance(ref, list) and ref:
                    by_idx: Dict[int, Dict[str, Any]] = {}
                    for item in ref:
                        if isinstance(item, dict) and item.get("slide_index") is not None:
                            try:
                                by_idx[int(item.get("slide_index"))] = item
                            except Exception:
                                continue
                    for o in parsed.get("outline") or []:
                        if not isinstance(o, dict):
                            continue
                        idx = o.get("slide_index")
                        if idx is None:
                            continue
                        try:
                            idx_i = int(idx)
                        except Exception:
                            continue

                        # Overwrite per-slide script using the globally-generated deck script slice if available.
                        sliced = slide_script_by_idx.get(idx_i)
                        if sliced:
                            o["suggested_script"] = sliced

                        r = by_idx.get(idx_i)
                        if not r:
                            continue
                        # Overwrite tips/transition with refined ones if provided.
                        if r.get("transition_hint"):
                            o["transition_hint"] = r.get("transition_hint")
                        if r.get("speaking_tips"):
                            o["speaking_tips"] = r.get("speaking_tips")
                        if r.get("talk_track"):
                            # Keep the longer per-slide script if it exists; store short talk-track separately.
                            o["talk_track"] = r.get("talk_track")
                        if r.get("section"):
                            o["section"] = r.get("section")
                        if r.get("role"):
                            o["role"] = r.get("role")

                # If we did not get slide_refinements (or some slides missing), still apply deck-sliced scripts.
                if slide_script_by_idx:
                    for o in parsed.get("outline") or []:
                        if not isinstance(o, dict):
                            continue
                        try:
                            idx_i = int(o.get("slide_index"))
                        except Exception:
                            continue
                        sliced = slide_script_by_idx.get(idx_i)
                        if sliced:
                            o["suggested_script"] = sliced

                # Final polish: backfill/replace overly-generic tips and templated transitions using slide/next-slide keywords.
                outline_list = parsed.get("outline") or []
                if isinstance(outline_list, list) and outline_list:
                    # Build quick index -> item
                    by_slide: Dict[int, Dict[str, Any]] = {}
                    for o in outline_list:
                        if not isinstance(o, dict) or o.get("slide_index") is None:
                            continue
                        try:
                            by_slide[int(o.get("slide_index"))] = o
                        except Exception:
                            continue

                    sorted_idxs = sorted(by_slide.keys())
                    for i, idx_i in enumerate(sorted_idxs):
                        cur = by_slide.get(idx_i)
                        if not cur:
                            continue
                        nxt_idx = sorted_idxs[i + 1] if i + 1 < len(sorted_idxs) else None
                        nxt = by_slide.get(nxt_idx) if nxt_idx is not None else None

                        cur_key = _pick_keyword(cur.get("title") or "", cur.get("key_points"))
                        next_key = _pick_keyword((nxt.get("title") if nxt else "") or "", (nxt.get("key_points") if nxt else [])) if nxt else "总结/收束"

                        # Strip greetings from any non-first slide scripts, and from all content pages.
                        page_type = str(cur.get("page_type") or "").strip().lower()
                        if idx_i != sorted_idxs[0] or page_type == "content":
                            if cur.get("suggested_script"):
                                cur["suggested_script"] = _strip_greetings(cur.get("suggested_script"))
                            if cur.get("talk_track"):
                                cur["talk_track"] = _strip_greetings(cur.get("talk_track"))

                        if _looks_templated_transition(cur.get("transition_hint")):
                            cur["transition_hint"] = _derive_transition(cur_key, next_key, idx_i)
                        if _looks_generic_tips(cur.get("speaking_tips")):
                            cur["speaking_tips"] = _derive_speaking_tips(cur_key, cur.get("key_points"), idx_i)

                # Final safety: ensure each outline item has non-empty narrative fields
                for o in parsed.get("outline") or []:
                    if not isinstance(o, dict):
                        continue
                    t = str(o.get("title") or "").strip()
                    kps = o.get("key_points")
                    if not isinstance(kps, list):
                        kps = []
                    kps = [str(x).strip() for x in kps if str(x).strip()]
                    o["key_points"] = kps[:6]

                    if not str(o.get("suggested_script") or "").strip():
                        if t and kps:
                            o["suggested_script"] = f"这一页的核心是：{t}。你可以先给出结论，再用两点支撑：{kps[0]}" + (f"；{kps[1]}" if len(kps) > 1 else "") + "。"
                        elif kps:
                            o["suggested_script"] = f"这一页重点有两点：{kps[0]}" + (f"；{kps[1]}" if len(kps) > 1 else "") + "。"
                        else:
                            o["suggested_script"] = "这一页先讲清核心结论，再列出 2-3 个要点支撑，最后用一句话引向下一页。"

                    if not str(o.get("speaking_tips") or "").strip():
                        o["speaking_tips"] = "读到关键数字时放慢语速并停顿 0.5-1 秒；用手势指向屏幕对应位置。"
                    if not str(o.get("transition_hint") or "").strip():
                        o["transition_hint"] = "收束本页结论后，抛出一个承接问题自然带到下一页。"

                return parsed
        except Exception:
            pass

        return {
            "outline": outline,
            "suggestions": [
                "为每页之间准备一句过渡语，确保逻辑连贯。",
                "开场先交代听众收益与结构，再进入正文。",
                "结尾总结 3 个要点并给出明确的下一步/行动号召。",
                "添加具体案例或数据来增强说服力。",
                "练习时控制每页讲解时间，确保节奏均匀。",
            ],
            "scores": {"total": 78, "structure": 78, "logic": 78, "content": 78},
            "improvement_areas": ["结构完整性", "内容丰富度"],
            "overall_structure": "",
            "deck_storyline": "",
            "estimated_total_duration_sec": total_est or None,
        }


async def generate_script_analysis(script_text: str) -> Dict[str, Any]:
    """Analyze a speech script and generate improvement suggestions.
    
    Returns:
        {
            "word_count": 1200,
            "estimated_duration_sec": 420,
            "structure": {
                "has_opening": true,
                "has_body": true,
                "has_closing": true,
                "sections": ["开场", "问题引入", "解决方案", "总结号召"]
            },
            "strengths": ["结构清晰", "论点明确"],
            "issues": ["缺少具体案例", "过渡不够自然"],
            "suggestions": ["建议1", "建议2", "建议3"],
            "key_points": ["要点1", "要点2", "要点3"],
            "opening_hook_score": 75,
            "logic_flow_score": 80,
            "emotional_appeal_score": 60,
            "overall_score": 72
        }
    """
    async with _glm_semaphore:
        client = get_client()

        def _safe_snippet(text: str, max_len: int = 120) -> str:
            t = " ".join((text or "").split()).strip()
            return (t[:max_len] + "…") if len(t) > max_len else t

        def _fallback_from_text(text: str, err_msg: str | None = None) -> Dict[str, Any]:
            """根据原文内容生成具体的分析和修改建议"""
            word_count = len(text)
            estimated_sec = int(word_count / 3)  # 180 chars/min ~= 3 chars/sec

            paragraphs = [p.strip() for p in (text or "").split("\n\n") if p.strip()]
            if not paragraphs:
                paragraphs = [text[:500]] if text else [""]
            
            opening = paragraphs[0] if paragraphs else ""
            closing = paragraphs[-1] if len(paragraphs) >= 2 else ""
            mid = paragraphs[len(paragraphs) // 2] if len(paragraphs) > 2 else (paragraphs[1] if len(paragraphs) > 1 else "")

            # 分析开场特点
            has_question = ("？" in opening) or ("?" in opening)
            has_number = any(ch.isdigit() for ch in (text or ""))
            has_greeting = any(k in opening[:50] for k in ["大家好", "各位", "欢迎", "我是", "今天我"])
            has_cta = any(k in (closing or "") for k in ["总结", "最后", "行动", "现在就", "接下来", "欢迎提问", "谢谢"])

            issues: list[str] = []
            # 不再显示技术性错误信息，改为友好的提示
            
            if has_greeting and not has_question:
                issues.append(f"开场可优化：目前以问候开头，建议改为\"问题/数据/故事\"吸引注意力")
            elif not has_question:
                issues.append(f"开场缺少钩子：建议用提问、惊人数据或短故事开场")
            
            if not has_number:
                issues.append("全文缺少数据支撑：建议每个核心论点至少补1个具体数字/百分比/对比")
            
            if not has_cta:
                issues.append(f"结尾偏弱：建议加入明确的行动号召或总结要点")

            # 3种风格的改写示例（每种至少3个）
            style_examples = {
                "professional": [],
                "storytelling": [],
                "concise": []
            }
            
            if opening:
                opening_short = _safe_snippet(opening, 60)
                style_examples["professional"].append({
                    "location": "开头第1-2句",
                    "original": opening_short,
                    "revised": "本次汇报聚焦3个问题：现状是什么、方案是什么、预期效果如何。首先看现状。",
                    "reason": "答辩风格：直接、克制、结构清晰"
                })
                style_examples["storytelling"].append({
                    "location": "开头第1-2句",
                    "original": opening_short,
                    "revised": "一个月前，我遇到了一个棘手的问题——系统总是在关键时刻崩溃。当时我就在想：如果能...结果我发现了一个方法。",
                    "reason": "故事化：用场景和悬念拉住注意力"
                })
                style_examples["concise"].append({
                    "location": "开头第1-2句",
                    "original": opening_short,
                    "revised": "3个问题。3个方案。5分钟讲完。开始。",
                    "reason": "极简风格：短句、强动词、高密度"
                })
            
            if mid:
                mid_short = _safe_snippet(mid, 60)
                style_examples["professional"].append({
                    "location": "正文中间段",
                    "original": mid_short,
                    "revised": "数据支撑这一观点：实验组效率提升32%，对照组仅9%。差异显著（p<0.01）。",
                    "reason": "商务风格：数据驱动，精准表达"
                })
                style_examples["storytelling"].append({
                    "location": "正文中间段",
                    "original": mid_short,
                    "revised": "我永远记得测试那天：屏幕上的数字从9%跳到32%——整个团队沸腾了。这意味着我们的方法有效。",
                    "reason": "故事化：把数据包裹在场景里"
                })
                style_examples["concise"].append({
                    "location": "正文中间段",
                    "original": mid_short,
                    "revised": "数据：效率+32%。对照组+9%。结论：有效。",
                    "reason": "极简：去掉所有修饰，只留核心"
                })
            
            if closing:
                closing_short = _safe_snippet(closing, 60)
                style_examples["professional"].append({
                    "location": "结尾",
                    "original": closing_short,
                    "revised": "综上，建议采纳方案A，预期3个月内见效。具体实施步骤见附件。谢谢，欢迎提问。",
                    "reason": "商务收尾：清晰行动项+开放讨论"
                })
                style_examples["storytelling"].append({
                    "location": "结尾",
                    "original": closing_short,
                    "revised": "故事还没结束——接下来的3个月，就看我们能否把这个方法落地。如果成功，它会改变整个行业的游戏规则。",
                    "reason": "故事收尾：留悬念，引发期待"
                })
                style_examples["concise"].append({
                    "location": "结尾",
                    "original": closing_short,
                    "revised": "总结：3点核心+1个行动。立刻开始。谢谢。",
                    "reason": "极简收尾：强指令，无废话"
                })

            return {
                "word_count": word_count,
                "estimated_duration_sec": estimated_sec,
                "structure": {
                    "has_opening": True,
                    "opening_type": "问题型" if has_question else ("问候型" if has_greeting else "陈述型"),
                    "has_body": True,
                    "body_logic": "待分析",
                    "has_closing": True,
                    "closing_type": "号召型" if has_cta else "平淡收尾",
                    "sections": [f"段落{i+1}" for i in range(min(5, len(paragraphs)))],
                },
                "strengths": ["稿件结构完整，有明确的开头和结尾"] if len(paragraphs) >= 3 else ["稿件已有基本内容"],
                "issues": issues[:5],
                "rewrite_style_options": [
                    {"id": "professional", "name": "专业答辩", "description": "克制、清晰、有逻辑，适合课堂汇报/答辩"},
                    {"id": "storytelling", "name": "故事化", "description": "用画面与情境拉住注意力，但不夸张"},
                    {"id": "concise", "name": "极简有力", "description": "短句、强动词、高信息密度"},
                ],
                "style_revision_examples": style_examples,
                "suggestions": [
                    "开场优化：用\"反直觉结论/问题/短故事\"替代问候语开场",
                    "正文加强：每个论点至少补1个数据/案例/对比",
                    "结尾升级：用\"总结3点+1个行动建议\"收束",
                ],
                "key_points": [],
                "hook_analysis": f"当前开场类型：{'问题型' if has_question else ('问候型' if has_greeting else '陈述型')}",
                "emotion_curve": "建议设计：开场引发好奇→正文层层递进→结尾呼吁行动",
                "opening_hook_score": 78 if has_question else (68 if has_greeting else 72),
                "logic_flow_score": 75,
                "emotional_appeal_score": 72,
                "overall_score": 75 if has_question else 70,
            }

        # Truncate if too long
        max_chars = 8000
        truncated = script_text[:max_chars] if len(script_text) > max_chars else script_text

        # 注意：此处不要用 f-string，因为 prompt 中包含大量字面量
        # JSON braces `{}` which would be treated as format placeholders.
        prompt = (
            "你是服务过马丁·路德·金和TED顶级演讲者的专业演讲教练。请对以下演讲稿进行**深度专业分析**。\n\n"
            "演讲稿内容：\n\"\"\"\n"
            + truncated
            + "\n\"\"\"\n\n"
            "## 核心要求\n\n"
            "### 1. issues 必须具体到段落位置\n"
            "❌ 禁止：\"缺少案例\"（哪里缺？）\n"
            "✅ 正确：\"第3段仅有抽象论述，建议补充1个具体数字或对比案例\"\n\n"
            "### 2. 3种风格改写示例 (style_revision_examples)\n"
            "每种风格至少给出 3 个示例，必须基于原文改写：\n"
            "- professional：商务答辩风，克制、清晰、逻辑强\n"
            "  * 例：\"本次汇报分3部分：现状分析、解决方案、预期效果。首先看现状。\"\n"
            "- storytelling：故事化/画面感\n"
            "  * 例：\"想象一个场景：你努力准备了一个月，结果却失败了。问题出在哪？\"\n"
            "- concise：极简、短句、信息密度高\n"
            "  * 例：\"3个问题。3个方案。5分钟讲完。开始。第一，现状：数据显示...\"\n\n"
            "### 3. 评分标准（必须严格执行，客观评分）\n"
            "\n"
            "⚠️ **核心原则：评分必须基于具体证据，不要虚高！**\n"
            "- 平常的学生汇报稿件：50-65分（结构完整但内容平淡）\n"
            "- 优秀的答辩稿件：70-80分（逻辑清晰，有数据支撑）\n"
            "- TED级别的演讲稿：85-95分（开场震撼，故事引人，结尾升华）\n"
            "\n"
            "- opening_hook_score (0-100)：\n"
            "  * 90-100：震撼开场（用数据/故事/反直觉结论开场，瞬间抓住注意力）\n"
            "  * 70-89：有效开场（用问题/场景引入，但不够震撼）\n"
            "  * 50-69：平淡开场（直接陈述主题，缺乏吸引力）\n"
            "  * 0-49：失败开场（问候式开场，无法吸引听众）\n"
            "\n"
            "- logic_flow_score (0-100)：\n"
            "  * 90-100：逻辑缜密，每个论点都有数据/案例支撑，过渡自然\n"
            "  * 70-89：逻辑清晰，但缺少具体支撑或过渡生硬\n"
            "  * 50-69：结构完整但内容空泛，缺乏因果递进关系\n"
            "  * 0-49：逻辑混乱，跳跃大，难以跟随\n"
            "\n"
            "- emotional_appeal_score (0-100)：\n"
            "  * 90-100：有故事/比喻/修辞，结尾有强烈呼吁，能引发共鸣\n"
            "  * 70-89：有一些修辞技巧，但情感染不够强\n"
            "  * 50-69：平铺直叙，缺乏画面感和情感\n"
            "  * 0-49：全程枯燥，没有任何情感波动\n"
            "\n"
            "- overall_score：三项加权平均，**必须客观严格**：\n"
            "  * 学生平常汇报稿件：50-65分\n"
            "  * 优秀答辩稿件：70-80分\n"
            "  * TED级别演讲：85+分\n"
            "  * **不要因为\"结构完整\"就给高分，要看内容质量！**\n\n"
            "### 4. 输出要求\n"
            "- issues 必须 3-6 条，每条指出具体位置和问题\n"
            "- style_revision_examples 每种风格至少 3 条\n"
            "- suggestions 必须 3-5 条综合建议（结构调整/演讲技巧/互动设计）\n\n"
            "请返回严格JSON格式：\n"
            "{\n"
            "  \"word_count\": 字数(整数),\n"
            "  \"estimated_duration_sec\": 预估演讲时长(整数，秒。按180字/分钟计算),\n"
            "  \"structure\": {\n"
            "    \"has_opening\": 是否有开场,\n"
            "    \"opening_type\": \"开场类型：故事型/数据型/提问型/陈述型/无\",\n"
            "    \"has_body\": 是否有正文论述,\n"
            "    \"body_logic\": \"正文逻辑：并列式/递进式/对比式/问题-方案式\",\n"
            "    \"has_closing\": 是否有结尾总结,\n"
            "    \"closing_type\": \"结尾类型：号召型/总结型/升华型/平淡收尾\",\n"
            "    \"sections\": [\"段落1主题\", \"段落2主题\", \"...\"]\n"
            "  },\n"
            "  \"strengths\": [\"具体的优点1（引用原文片段说明）\", \"具体的优点2\"],\n"
            "  \"issues\": [\"具体的问题1（指出位置和原因）\", \"具体的问题2\"],\n"
            "  \"rewrite_style_options\": [\n"
            "    {\"id\": \"professional\", \"name\": \"专业答辩\", \"description\": \"克制、清晰、有逻辑，适合课堂汇报/答辩\"},\n"
            "    {\"id\": \"storytelling\", \"name\": \"故事化\", \"description\": \"用画面与情境拉住注意力，但不夸张\"},\n"
            "    {\"id\": \"concise\", \"name\": \"极简有力\", \"description\": \"短句、强动词、高信息密度\"}\n"
            "  ],\n"
            "  \"style_revision_examples\": {\n"
            "    \"professional\": [{\"location\": \"...\", \"original\": \"...\", \"revised\": \"...\", \"reason\": \"...\"}],\n"
            "    \"storytelling\": [{\"location\": \"...\", \"original\": \"...\", \"revised\": \"...\", \"reason\": \"...\"}],\n"
            "    \"concise\": [{\"location\": \"...\", \"original\": \"...\", \"revised\": \"...\", \"reason\": \"...\"}]\n"
            "  },\n"
            "  \"suggestions\": [\"综合建议1：针对整体结构的优化方向\", \"综合建议2：演讲技巧建议（哪里该停顿、强调）\", \"综合建议3：可添加的互动设计\"],\n"
            "  \"key_points\": [\"核心论点1\", \"核心论点2\", \"核心论点3\"],\n"
            "  \"hook_analysis\": \"开场钩子详细评价：具体分析为什么吸引人/不吸引人\",\n"
            "  \"emotion_curve\": \"情感曲线描述：开场→发展→高潮→结尾的情感走向\",\n"
            "  \"opening_hook_score\": 开场吸引力评分(0-100),\n"
            "  \"logic_flow_score\": 逻辑流畅度评分(0-100),\n"
            "  \"emotional_appeal_score\": 情感感染力评分(0-100),\n"
            "  \"overall_score\": 综合评分(0-100，三项加权平均)\n"
            "}\n\n"
            "评分必须基于具体证据，不要虚高。只返回JSON。"
        )

        try:
            response = await asyncio.to_thread(
                client.chat.completions.create,
                model="glm-4v-flash",
                messages=[{"role": "user", "content": prompt}],
            )
            content = response.choices[0].message.content
        except Exception as e:
            # Network/auth/quota/etc: return a non-empty, user-actionable fallback
            return _fallback_from_text(script_text, str(e))
        
        import json
        try:
            # 使用更健壮的 JSON 提取方法
            result = _extract_json_payload(content)
            
            if not isinstance(result, dict):
                return _fallback_from_text(script_text, "返回格式异常")
            
            # Ensure required fields
            word_count = len(script_text)
            result.setdefault("word_count", word_count)
            
            # Validate and fix estimated_duration_sec
            # 180 chars/min = 3 chars/sec, so duration = word_count / 3
            expected_sec = int(word_count / 3)
            glm_sec = result.get("estimated_duration_sec")
            
            # If GLM returned something unreasonable (less than 50% of expected), recalculate
            # GLM might return minutes instead of seconds, or just be wrong
            if not isinstance(glm_sec, (int, float)) or glm_sec < expected_sec * 0.5:
                result["estimated_duration_sec"] = expected_sec
            
            result.setdefault("suggestions", [])
            result.setdefault("overall_score", 70)
            result.setdefault("rewrite_style_options", [])
            result.setdefault("style_revision_examples", {})
            result.setdefault("strengths", [])
            result.setdefault("issues", [])

            # Ensure non-empty core outputs (avoid blank UI/PDF)
            if not isinstance(result.get("issues"), list):
                result["issues"] = []
            if len(result.get("issues") or []) == 0:
                fb = _fallback_from_text(script_text)
                if len(result.get("issues") or []) == 0:
                    result["issues"] = fb.get("issues", [])
                if len(result.get("strengths") or []) == 0:
                    result["strengths"] = fb.get("strengths", [])
            
            return result
        except Exception:
            return _fallback_from_text(script_text, "JSON 解析失败")
