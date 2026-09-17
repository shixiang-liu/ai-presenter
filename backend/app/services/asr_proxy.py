"""百度实时语音识别 WebSocket 代理。

后端代连百度 ASR，用于保护密钥。
"""
import asyncio
import json
import uuid
import hashlib
import hmac
import base64
import time
import aiohttp
from typing import Callable, Optional
from ..config import settings

class BaiduASRProxy:
    """
    百度实时语音识别 WebSocket 代理
    
    流程：
    1. 前端通过 WebSocket 发送 PCM 音频到后端
    2. 后端转发到百度 ASR WebSocket
    3. 后端接收识别结果并转发回前端
    """
    
    BAIDU_ASR_URL = "wss://vop.baidu.com/realtime_asr"
    
    def __init__(self, on_result: Callable, on_error: Optional[Callable] = None):
        self.on_result = on_result
        self.on_error = on_error
        self.ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.is_running = False
        self.sn = str(uuid.uuid4())
        
    def _get_auth_url(self) -> str:
        """获取带 sn 参数的 WebSocket 地址"""
        return f"{self.BAIDU_ASR_URL}?sn={self.sn}"
    
    async def connect(self) -> bool:
        """连接百度 ASR WebSocket
        
        According to Baidu docs: https://ai.baidu.com/ai-doc/SPEECH/Vk38lxily
        START 帧只需要 appid 与 appkey。
        """
        try:
            if not (settings.BAIDU_APP_ID and settings.BAIDU_API_KEY):
                raise RuntimeError(
                    "Baidu ASR 未配置：请在 backend/.env 设置 BAIDU_APP_ID、BAIDU_API_KEY"
                )

            print("[ASR] 正在连接百度 ASR...")
            print(f"[ASR] APP_ID: {settings.BAIDU_APP_ID}, API_KEY: {settings.BAIDU_API_KEY[:8]}***")
            
            self.session = aiohttp.ClientSession()
            url = self._get_auth_url()
            print(f"[ASR] WebSocket 地址: {url}")
            
            self.ws = await self.session.ws_connect(url)
            self.is_running = True
            print("[ASR] WebSocket 已连接")
            
            # 发送 START 帧（按百度协议）
            # 开启动纠错，加快中间结果
            start_frame = {
                "type": "START",
                "data": {
                    "appid": int(settings.BAIDU_APP_ID),
                    "appkey": settings.BAIDU_API_KEY,
                    "dev_pid": 15372,  # 普通话搜索模型-强标点
                    "cuid": f"ai_presenter_{uuid.uuid4().hex[:8]}",
                    "format": "pcm",
                    "sample": 16000,
                    "vad_enable": True,  # 启用语音活动检测（VAD）
                    "auto_space": True,  # 中英混排自动空格
                }
            }
            print(f"[ASR] Sending START frame: {json.dumps(start_frame, ensure_ascii=False)}")
            await self.ws.send_str(json.dumps(start_frame))
            print("[ASR] START 帧已发送，等待响应...")
            
            # 启动接收协程
            asyncio.create_task(self._receive_loop())
            
            # 稍等片刻，确保连接稳定且鉴权通过
            # 接收循环在后台运行，此处不直接等待消息，以免抢占消费
            # 这里只检查循环是否仍在运行
            await asyncio.sleep(0.5)
            if not self.is_running:
                print("[ASR] START 后连接立即关闭")
                return False
            
            return True
        except Exception as e:
            import traceback
            print(f"[ASR] Connection failed: {e}")
            traceback.print_exc()
            if self.on_error:
                await self.on_error(str(e))
            return False
    
    async def _receive_loop(self):
        """接收百度 ASR 推送的消息"""
        print("[ASR] 接收循环已启动")
        try:
            async for msg in self.ws:
                print(f"[ASR] 收到 WebSocket 消息类型: {msg.type}")
                if msg.type == aiohttp.WSMsgType.TEXT:
                    print(
                        f"[ASR] 原始消息: {msg.data[:200]}..."
                        if len(msg.data) > 200
                        else f"[ASR] 原始消息: {msg.data}"
                    )
                    data = json.loads(msg.data)
                    await self._handle_message(data)
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    print(f"[ASR] 收到二进制数据: {len(msg.data)} bytes")
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    exc = None
                    try:
                        exc = self.ws.exception()
                    except Exception:
                        exc = None
                    print(
                        f"[ASR] WebSocket 异常: {repr(exc)} closed={getattr(self.ws, 'closed', None)} close_code={getattr(self.ws, 'close_code', None)}"
                    )
                    if self.on_error:
                        await self.on_error(f"WebSocket error: {repr(exc)}")
                    break
                elif msg.type == aiohttp.WSMsgType.CLOSED:
                    print(f"[ASR] 服务端关闭连接 close_code={getattr(self.ws, 'close_code', None)}")
                    break
                elif msg.type == aiohttp.WSMsgType.CLOSE:
                    print(f"[ASR] 收到关闭帧 close_code={getattr(self.ws, 'close_code', None)}")
                    break
        except Exception as e:
            print(f"[ASR] 接收循环异常: {repr(e)}")
            import traceback
            traceback.print_exc()
            if self.on_error:
                await self.on_error(str(e))
        finally:
            print(f"[ASR] 接收循环结束 closed={getattr(self.ws, 'closed', None)} close_code={getattr(self.ws, 'close_code', None)}")
            self.is_running = False
    
    async def _handle_message(self, data: dict):
        """处理百度 ASR 的消息"""
        msg_type = data.get("type")
        print(f"[ASR] 收到消息类型: {msg_type}")
        
        if msg_type == "MID_TEXT":
            # 中间结果（无时间戳）
            result = data.get("result", "")
            print(f"[ASR] 中间结果: {result[:50]}..." if len(result) > 50 else f"[ASR] 中间结果: {result}")
            await self.on_result({
                "type": "mid_text",
                "text": result
            })
            
        elif msg_type == "FIN_TEXT":
            # 最终结果（含时间戳）
            result = data.get("result", "")
            start_time = data.get("start_time", 0)
            end_time = data.get("end_time", 0)
            print(f"[ASR] 最终结果: {result}")
            await self.on_result({
                "type": "fin_text",
                "text": result,
                "start_ms": start_time,
                "end_ms": end_time
            })
            
        elif msg_type == "HEARTBEAT":
            # 回复心跳，保持连接
            try:
                await self.ws.send_str(json.dumps({"type": "HEARTBEAT"}))
                print("[ASR] 已回复心跳")
            except Exception as e:
                print(f"[ASR] 回复心跳失败: {e}")
            
        elif data.get("err_no", 0) != 0:
            # 错误返回
            print(f"[ASR] Error: {data}")
            if self.on_error:
                await self.on_error(f"ASR Error {data.get('err_no')}: {data.get('err_msg', 'Unknown')}")
    
    async def send_audio(self, pcm_data: bytes):
        """向百度 ASR 发送 PCM 音频"""
        if self.ws and self.is_running:
            try:
                # 仅偶尔输出日志，避免刷屏
                if not hasattr(self, '_log_counter'):
                    self._log_counter = 0
                self._log_counter += 1
                if self._log_counter % 50 == 0:  # Log every ~5 seconds (assuming 100ms chunks)
                    print(f"[ASR] Sending audio chunk {self._log_counter}, size: {len(pcm_data)} bytes")
                
                await self.ws.send_bytes(pcm_data)
            except Exception as e:
                print(f"[ASR] Send audio error: {e}")
                if self.on_error:
                    await self.on_error(str(e))
    
    async def finish(self):
        """发送 FINISH 帧并关闭连接"""
        if self.ws and self.is_running:
            try:
                finish_frame = {"type": "FINISH"}
                await self.ws.send_str(json.dumps(finish_frame))
                # 等待片刻，接收最终结果
                await asyncio.sleep(0.5)
            except:
                pass
        await self.close()
    
    async def close(self):
        """关闭连接"""
        self.is_running = False
        if self.ws:
            await self.ws.close()
        if self.session:
            await self.session.close()


async def get_baidu_access_token() -> str:
    """获取百度 REST 接口令牌"""
    url = "https://aip.baidubce.com/oauth/2.0/token"
    params = {
        "grant_type": "client_credentials",
        "client_id": settings.BAIDU_API_KEY,
        "client_secret": settings.BAIDU_SECRET_KEY
    }
    
    async with aiohttp.ClientSession() as session:
        async with session.post(url, params=params) as resp:
            data = await resp.json()
            return data.get("access_token", "")
