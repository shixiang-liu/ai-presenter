import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Play, Square, ChevronLeft, ChevronRight,
  Volume2, VolumeX, X, RotateCcw, Camera
} from 'lucide-react'
import { usePracticeStore } from '../../stores'
import { getSession, createWebSocket, uploadVideo, finishSession, getSlideImageUrl } from '../../services/api'
import HUD from '../../components/HUD'
import CameraPiP from '../../components/CameraPiP'
import Teleprompter from '../../components/Teleprompter'
import ScriptTeleprompter from '../../components/ScriptTeleprompter'
import useMediaPipe from '../../hooks/useMediaPipe'
import useAudioCapture from '../../hooks/useAudioCapture'

export default function PracticePage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()

  const {
    session,
    slides, currentSlideIndex,
    isRecording, elapsedTime, asrText, asrTranscript, currentSpeed, fillerCount,
    ttsEnabled, setSession, setSlideIndex, startRecording, stopRecording,
    updateElapsedTime, addEvent, toggleTts, reset
  } = usePracticeStore()

  const sessionMode = (session as any)?.mode
  const scriptText = (session as any)?.script_text as string | undefined

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraPiPRef = useRef<any>(null)  // CameraPiP的ref，用于获取其video元素
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  // 改用状态机：记录是否处于问题状态中，而不是持续检测
  const headDownStartRef = useRef<number | null>(null)
  const lookAwayStartRef = useRef<number | null>(null)
  const isInHeadDownState = useRef<boolean>(false)  // 当前是否处于低头状态
  const isInLookAwayState = useRef<boolean>(false)  // 当前是否处于视线偏离状态
  const ttsCooldownRef = useRef<number>(0)
  const isRecordingRef = useRef<boolean>(false)  // 使用ref存储isRecording状态，避免闭包陷阱

  // Sustained fast speech (PRD: >10s)
  const fastSpeedStartRef = useRef<number | null>(null)

  // Body sway tracking (Pose)
  const swayWindowRef = useRef<Array<{ t: number; x: number; y: number }>>([])
  const swayCooldownRef = useRef<number>(0)

  // Face bounding box for PiP overlay
  const [faceBoundingBox, setFaceBoundingBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)

  // 同步isRecording状态到ref
  useEffect(() => {
    isRecordingRef.current = isRecording
    console.log('[Practice] isRecording 状态更新:', isRecording)
  }, [isRecording])

  // Calibration status for "look at camera" prompt
  const [isCalibrating, setIsCalibrating] = useState(false)
  const [calibrationProgress, setCalibrationProgress] = useState(0)

  // Real-time head tracking status for HUD
  const [headStatus, setHeadStatus] = useState<'normal' | 'head_down' | 'look_away' | null>(null)
  const [headDownCount, setHeadDownCount] = useState(0)
  const [lookAwayCount, setLookAwayCount] = useState(0)

  const speak = useCallback((text: string) => {
    if (!ttsEnabled) {
      console.log('[TTS] 已禁用，不播报:', text)
      return
    }
    const now = Date.now()
    if (now - ttsCooldownRef.current < 5000) {
      console.log('[TTS] 冷却中，跳过:', text)
      return
    }
    ttsCooldownRef.current = now
    console.log('[TTS] 播报:', text)
    try {
      if (!('speechSynthesis' in window)) return
      window.speechSynthesis.cancel()
      const utter = new SpeechSynthesisUtterance(text)
      utter.lang = 'zh-CN'
      utter.rate = 1
      window.speechSynthesis.speak(utter)
    } catch {
      // ignore
    }
  }, [ttsEnabled])

  const sendRealtimeEvent = useCallback((payload: any) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    // 携带当前slide_index用于分页统计
    const eventWithSlide = {
      ...payload,
      slide_index: slides.length > 0 ? currentSlideIndex + 1 : undefined
    }
    wsRef.current.send(JSON.stringify({ type: 'event', data: eventWithSlide }))
  }, [slides.length, currentSlideIndex])

  // MediaPipe hook
  const { isReady: mediaPipeReady, startDetection, stopDetection, recalibrate } = useMediaPipe({
    onPoseUpdate: (landmarks) => {
      // Basic body sway detection using shoulder center movement.
      // Emits a medium issue when horizontal sway is明显且持续。
      if (!Array.isArray(landmarks) || landmarks.length < 13) return
      const nowMs = elapsedTime
      const leftShoulder = landmarks[11]
      const rightShoulder = landmarks[12]
      if (!leftShoulder || !rightShoulder) return

      const cx = (leftShoulder.x + rightShoulder.x) / 2
      const cy = (leftShoulder.y + rightShoulder.y) / 2

      const buf = swayWindowRef.current
      buf.push({ t: nowMs, x: cx, y: cy })
      // keep ~4s window
      while (buf.length > 0 && nowMs - buf[0].t > 4000) buf.shift()

      if (buf.length < 8) return
      const xs = buf.map(p => p.x)
      const xRange = Math.max(...xs) - Math.min(...xs)

      // Threshold tuned for normalized coordinates
      const SWAY_X_RANGE = 0.10
      const now = Date.now()
      if (xRange >= SWAY_X_RANGE && now - swayCooldownRef.current > 12000) {
        swayCooldownRef.current = now
        const start = buf[0].t
        const end = buf[buf.length - 1].t
        const ev = {
          session_id: sessionId!,
          type: 'issue',
          category: 'body_sway',
          severity: 'medium',
          start_ms: start,
          end_ms: end,
          evidence: { x_range: xRange, threshold_x_range: SWAY_X_RANGE },
        }
        addEvent({ id: Date.now(), ...(ev as any) })
        sendRealtimeEvent(ev)
      }
    },
    onFaceBoundingBox: (box) => {
      setFaceBoundingBox(box)
    },
    onCalibrationStatus: (calibrating, progress) => {
      setIsCalibrating(calibrating)
      setCalibrationProgress(progress)
    },
    onHeadPose: (pitch, yaw, roll) => {
      // 只在录制状态下才检测问题
      if (!isRecordingRef.current) return
      
      const nowMs = performance.now()  // 使用高精度时间戳
      
      // 注意：pitch/yaw/roll 已经是相对于校准基准的偏移量（0° = 正常姿态）
      // 大厂标准（相对于用户自己的正常姿态）：
      // - 低头：向下偏移 > 8° (pitch < -8)
      // - 视线偏离：左右偏移 > 10° (|yaw| > 10)
      const isHeadDown = pitch < -8  // 相对于基准向下8度
      const isLookAway = Math.abs(yaw) > 10  // 相对于基准左右10度

      // ========== 低头检测：状态机模式 ==========
      if (isHeadDown) {
        // 进入低头状态
        if (!isInHeadDownState.current) {
          isInHeadDownState.current = true
          headDownStartRef.current = nowMs
          setHeadStatus('head_down')
          console.log('[HeadPose] 进入低头状态, 相对基准偏移:', pitch.toFixed(1), '度')
        }
      } else {
        // 离开低头状态
        if (isInHeadDownState.current && headDownStartRef.current !== null) {
          const duration = nowMs - headDownStartRef.current
          console.log('[HeadPose] 离开低头状态, 持续:', duration.toFixed(0), 'ms')
          
          // 只要低头超过800ms就算一次事件（大厂标准：快速反馈）
          if (duration >= 800) {
            const ev = {
              session_id: sessionId!,
              type: 'issue',
              category: 'head_down',
              severity: 'high',
              start_ms: elapsedTime,  // 使用录制时间轴的时间戳发送给后端
              end_ms: elapsedTime,
              evidence: { duration_ms: duration, pitch, yaw, roll, threshold_pitch_deg: -8 },
            }
            addEvent({ id: Date.now(), ...(ev as any) })
            sendRealtimeEvent(ev)
            setHeadDownCount(prev => prev + 1)
            speak('请保持抬头看向镜头')
            console.log('[HeadPose] 记录低头事件, 次数:', headDownCount + 1)
          }
          
          isInHeadDownState.current = false
          headDownStartRef.current = null
          setHeadStatus(null)
        }
      }

      // ========== 视线偏离检测：状态机模式 ==========
      if (isLookAway) {
        // 进入视线偏离状态
        if (!isInLookAwayState.current) {
          isInLookAwayState.current = true
          lookAwayStartRef.current = nowMs
          setHeadStatus('look_away')
          console.log('[HeadPose] 进入视线偏离状态, 相对基准偏移:', yaw.toFixed(1), '度')
        }
      } else {
        // 离开视线偏离状态
        if (isInLookAwayState.current && lookAwayStartRef.current !== null) {
          const duration = nowMs - lookAwayStartRef.current
          console.log('[HeadPose] 离开视线偏离状态, 持续:', duration.toFixed(0), 'ms')
          
          // 只要偏离超过1000ms就算一次事件
          if (duration >= 1000) {
            const ev = {
              session_id: sessionId!,
              type: 'issue',
              category: 'look_away',
              severity: 'high',
              start_ms: elapsedTime,
              end_ms: elapsedTime,
              evidence: { duration_ms: duration, pitch, yaw, roll, threshold_yaw_deg: 10 },
            }
            addEvent({ id: Date.now(), ...(ev as any) })
            sendRealtimeEvent(ev)
            setLookAwayCount(prev => prev + 1)
            speak('请正视镜头')
            console.log('[HeadPose] 记录视线偏离事件, 次数:', lookAwayCount + 1)
          }
          
          isInLookAwayState.current = false
          lookAwayStartRef.current = null
          setHeadStatus(null)
        }
      }
    }
  })

  // Audio capture hook
  const { startCapture, stopCapture } = useAudioCapture({
    onAudioData: (pcmData) => {
      // Send to WebSocket
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Log sparingly to debug data flow
        if (Math.random() < 0.01) {
          console.log('[Practice] Sending audio chunk, size:', pcmData.byteLength)
        }
        wsRef.current.send(pcmData)
      } else {
        if (Math.random() < 0.01) {
          console.warn('[Practice] Dropping audio, WS not open. ReadyState:', wsRef.current?.readyState)
        }
      }
    }
  })

  // Load session data
  useEffect(() => {
    if (!sessionId) return

    async function loadSession() {
      try {
        const data = await getSession(sessionId!)
        setSession(data as any, data.slides || [])
        setLoading(false)
      } catch (err) {
        setError('Failed to load session')
        setLoading(false)
      }
    }

    loadSession()

    return () => {
      reset()
    }
  }, [sessionId])

  // Setup camera
  useEffect(() => {
    async function setupCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1920, height: 1080 },
          audio: true
        })
        streamRef.current = stream
        setCameraStream(stream)
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
      } catch (err) {
        setError('无法访问摄像头/麦克风')
      }
    }

    setupCamera()

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      // 清理时停止检测
      stopDetection()
    }
  }, [])

  // Start MediaPipe detection when camera and MediaPipe are ready (只启动一次)
  useEffect(() => {
    if (!mediaPipeReady || !cameraStream) return
    
    // PPT模式下使用CameraPiP的video元素，其他模式使用videoRef
    const getVideoElement = () => {
      const isPPT = slides.length > 0
      if (isPPT && cameraPiPRef.current?.videoElement) {
        return cameraPiPRef.current.videoElement
      }
      return videoRef.current
    }
    
    const video = getVideoElement()
    if (!video) return
    
    let hasStarted = false
    
    const startWhenReady = () => {
      if (hasStarted) return
      
      if (video.readyState >= 2) {
        hasStarted = true
        startDetection(video)
        console.log('[MediaPipe] 人脸识别已启动')
      } else {
        video.addEventListener('loadeddata', () => {
          if (!hasStarted) {
            hasStarted = true
            startDetection(video)
            console.log('[MediaPipe] 人脸识别已启动')
          }
        }, { once: true })
      }
    }
    
    startWhenReady()
    
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaPipeReady, cameraStream, slides.length])  // 使用slides.length来判断是否PPT模式

  // WebSocket connection
  useEffect(() => {
    if (!sessionId || !isRecording) return

    const ws = createWebSocket(sessionId)
    wsRef.current = ws

    ws.onopen = () => {
      // Start ASR
      ws.send(JSON.stringify({
        type: 'start_asr',
        base_time_ms: Date.now()
      }))
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      console.log('[WS] Received:', data.type, data)

      // Use getState() to get latest values and avoid stale closures
      const store = usePracticeStore.getState()

      if (data.type === 'asr.started') {
        console.log('[ASR] 语音识别已启动')
      } else if (data.type === 'asr.mid_text') {
        store.addAsrText(data.text, false)
        // Also trigger speed update based on cumulative chars for faster feedback
        const currentTranscript = store.asrTranscript || ''
        const midText = data.text || ''
        const totalChars = (currentTranscript + midText).replace(/\s+/g, '').length
        if (store.elapsedTime > 3000 && totalChars > 5) {
          const minutes = store.elapsedTime / 1000 / 60
          const calculatedSpeed = Math.round(totalChars / minutes)
          if (calculatedSpeed >= 60 && calculatedSpeed <= 400) {
            store.updateMetrics(calculatedSpeed, store.fillerCount)
          }
        }
      } else if (data.type === 'asr.fin_text') {
        store.addAsrText(data.text, true)
        // Calculate speed - 改进：增加最小时长阈值，避免短片段导致的极端语速值
        const durationMs = data.end_ms - data.start_ms
        const durationMin = durationMs / 1000 / 60 // minutes
        const chars = (data.text || '').replace(/\s+/g, '').length // 只计算非空白字符

        // 只有当片段时长>=500ms且字数>=2时才计算语速，避免极端值
        if (durationMs >= 500 && chars >= 2 && durationMin > 0) {
          const speed = Math.round(chars / durationMin)
          // 合理范围检查：正常语速在80-350之间
          if (speed >= 60 && speed <= 400) {
            store.updateMetrics(speed, store.fillerCount)
          }
        }

        // Sustained fast speech -> TTS reminder (only when enabled)
        try {
          const nowMs = store.elapsedTime
          const FAST_CPM = 280 // 提高阈值，减少误报
          if (durationMs >= 500 && chars >= 2 && durationMin > 0) {
            const cpm = Math.round(chars / durationMin)
            if (cpm >= FAST_CPM) {
              if (fastSpeedStartRef.current === null) fastSpeedStartRef.current = nowMs
              const sustained = nowMs - fastSpeedStartRef.current
              if (sustained >= 10000) {
                speak('语速太快了，请放慢一点')
                fastSpeedStartRef.current = nowMs
              }
            } else {
              fastSpeedStartRef.current = null
            }
          }
        } catch {
          // ignore
        }
      } else if (data.type === 'report.event') {
        console.log('[WS] 收到事件:', data.event?.category)
        store.addEvent(data.event)

        // Keep HUD counts in sync with server-side detection
        if (data.event?.category === 'filler_word') {
          store.updateMetrics(store.currentSpeed, store.fillerCount)
          // 口头禅实时语音提醒 - 每检测到3次提醒一次
          const newCount = store.fillerCount + 1
          console.log('[口头禅] 检测到第', newCount, '次')
          if (newCount % 3 === 0) {
            speak('注意口头禅')
          }
        }
      } else if (data.type === 'asr.error') {
        console.error('[ASR] Error:', data.error)
        store.addAsrText(`语音识别失败: ${data.error || '未知错误'}`, true)
      }
    }

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop_asr' }))
        ws.close()
      }
    }
    // Only depend on sessionId and isRecording - use refs for callbacks to avoid reconnection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isRecording])

  // Timer
  useEffect(() => {
    if (isRecording) {
      timerRef.current = window.setInterval(() => {
        updateElapsedTime(Date.now() - usePracticeStore.getState().baseTime)
      }, 100)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }
  }, [isRecording])

  const handleStart = useCallback(async () => {
    if (!streamRef.current) return

    // Start MediaRecorder
    const mediaRecorder = new MediaRecorder(streamRef.current, {
      mimeType: 'video/webm;codecs=vp9,opus'
    })

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunksRef.current.push(e.data)
      }
    }
    mediaRecorderRef.current = mediaRecorder
    mediaRecorder.start(1000) // Collect data every second

    try {
      // Start audio capture for ASR
      await startCapture()

      // MediaPipe detection already running, just start recording
      startRecording()

      // PPT mode: mark slide 1 start at t=0 for accurate per-slide timing
      if (slides.length > 0) {
        // wait a tick for WS
        setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'page_turn',
              slide_index: 1,
              time_ms: 0,
            }))
          }
        }, 0)
      }
    } catch (err) {
      console.error('Start failure:', err)
      setError('启动失败')
    }
  }, [mediaPipeReady, startCapture, startDetection, startRecording, slides.length])

  const handleStop = useCallback(async () => {
    stopRecording()
    stopCapture()
    stopDetection()

    // PPT mode: close current slide end time
    if (slides.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'session_end',
        slide_index: currentSlideIndex + 1,
        time_ms: elapsedTime,
      }))
    }

    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop()

      // Wait for final data
      await new Promise(resolve => setTimeout(resolve, 500))

      // Upload video
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' })
      await uploadVideo(sessionId!, blob)

      // Finish session and trigger analysis
      await finishSession(sessionId!)

      // Navigate to review
      navigate(`/review/${sessionId}`)
    }
  }, [currentSlideIndex, elapsedTime, navigate, sessionId, slides.length, stopCapture, stopDetection, stopRecording])

  const handleSlideChange = useCallback((direction: 'prev' | 'next') => {
    if (slides.length === 0) return
    const newIndex = direction === 'prev'
      ? Math.max(0, currentSlideIndex - 1)
      : Math.min(slides.length - 1, currentSlideIndex + 1)

    setSlideIndex(newIndex)

    // Send page turn event
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'page_turn',
        // Backend uses 1-based slide_index to align with stored slide records
        slide_index: newIndex + 1,
        time_ms: elapsedTime
      }))
    }
  }, [currentSlideIndex, slides.length, elapsedTime, setSlideIndex])

  // Keyboard shortcuts
  useEffect(() => {
    if (slides.length === 0) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        handleSlideChange('prev')
      } else if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        handleSlideChange('next')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSlideChange, slides.length])

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  // --------------------------------------------------------------------------------
  // Layout Helpers
  // --------------------------------------------------------------------------------
  const isPPTMode = slides.length > 0
  const isScriptMode = !isPPTMode && sessionMode === 'script'
  const isFreeMode = !isPPTMode && sessionMode !== 'script'

  if (loading) {
    return (
      <div className="h-screen w-full bg-slate-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
          <div className="text-slate-400 text-sm font-medium tracking-wider">正在初始化演播厅...</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-screen w-full bg-slate-950 flex items-center justify-center">
        <div className="text-red-400 text-lg font-medium bg-red-500/10 px-6 py-4 rounded-xl border border-red-500/20">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-screen w-full bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-[#0a0a0a] to-black text-slate-200 overflow-hidden flex selection:bg-emerald-500/30">

      {/* 
        MAIN CONTENT AREA 
        Flex-row to accommodate Sidebar for PPT mode
      */}
      <div className="flex-1 relative flex flex-col h-full overflow-hidden">

        {/* Exit Button - Top Left */}
        <button
          onClick={() => {
            if (isRecording) {
              if (confirm('录制中，确定要退出吗？已录制内容将丢失。')) {
                handleStop()
                navigate('/')
              }
            } else {
              navigate('/')
            }
          }}
          className="absolute top-4 left-4 z-50 p-2.5 rounded-xl bg-black/40 hover:bg-black/60 backdrop-blur-md border border-white/10 text-white/70 hover:text-white transition-all group"
          title="返回首页"
        >
          <X className="w-5 h-5" />
        </button>

        {/* UPPER STAGE (Video / PPT) */}
        <div className="flex-1 relative overflow-hidden flex items-center justify-center">

          {/* --- PPT MODE --- */}
          {isPPTMode && (
            <div className="relative w-full h-full flex items-center justify-center p-8">
              {/* Stage Effect Background */}
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-emerald-900/10 to-transparent pointer-events-none" />

              <div className="relative max-w-full max-h-full aspect-[16/9] shadow-2xl rounded-xl overflow-hidden ring-1 ring-white/10 group">
                <img
                  src={getSlideImageUrl(sessionId!, currentSlideIndex + 1)}
                  alt={`Slide ${currentSlideIndex + 1}`}
                  className="w-full h-full object-contain bg-black"
                />

                {/* ASR Subtitles Overlay */}
                {isRecording && asrText && (
                  <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-[90%] max-w-3xl">
                    <div className="bg-black/60 backdrop-blur-md px-6 py-4 rounded-2xl text-center border border-white/5 shadow-xl">
                      <span className="text-white text-lg font-medium leading-relaxed drop-shadow-md">
                        {asrText}
                      </span>
                    </div>
                  </div>
                )}

                {/* Slide Nav Controls (Hover) */}
                <div className="absolute inset-x-0 bottom-0 p-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex justify-center items-center gap-6 bg-gradient-to-t from-black/80 to-transparent pt-12">
                  <button
                    onClick={() => handleSlideChange('prev')}
                    disabled={currentSlideIndex === 0}
                    className="p-2 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-0 transition-all backdrop-blur-md border border-white/10"
                  >
                    <ChevronLeft className="w-6 h-6 text-white" />
                  </button>
                  <span className="text-white/80 font-mono text-sm tracking-widest bg-black/40 px-3 py-1 rounded-full border border-white/5">
                    {String(currentSlideIndex + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}
                  </span>
                  <button
                    onClick={() => handleSlideChange('next')}
                    disabled={currentSlideIndex === slides.length - 1}
                    className="p-2 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-0 transition-all backdrop-blur-md border border-white/10"
                  >
                    <ChevronRight className="w-6 h-6 text-white" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* --- FREE / FULL CAMERA MODE --- */}
          {isFreeMode && (
            <div className="w-full h-full relative bg-black">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover opacity-90"
                style={{ transform: 'scaleX(-1)' }}
              />

              {/* Cinematic Frame Overlay */}
              <div className="absolute inset-0 pointer-events-none">
                {/* Grid Lines (Rule of Thirds) */}
                <div className="w-full h-full opacity-10 flex flex-col">
                  <div className="flex-1 border-b border-white" />
                  <div className="flex-1 border-b border-white" />
                  <div className="flex-1" />
                </div>
                <div className="absolute inset-0 w-full h-full opacity-10 flex">
                  <div className="flex-1 border-r border-white" />
                  <div className="flex-1 border-r border-white" />
                  <div className="flex-1" />
                </div>
                
                {/* Face Box - 人脸识别标框 */}
                {faceBoundingBox && (
                  <div className="absolute inset-0">
                    <div
                      className="absolute border-2 border-emerald-500/60 rounded-lg shadow-[0_0_20px_rgba(16,185,129,0.3)]"
                      style={{
                        right: `${faceBoundingBox.x * 100}%`,
                        top: `${faceBoundingBox.y * 100}%`,
                        width: `${faceBoundingBox.width * 100}%`,
                        height: `${faceBoundingBox.height * 100}%`
                      }}
                    >
                      {/* 四角装饰线 */}
                      <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-emerald-400 -translate-x-px -translate-y-px" />
                      <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-emerald-400 translate-x-px -translate-y-px" />
                      <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-emerald-400 -translate-x-px translate-y-px" />
                      <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-emerald-400 translate-x-px translate-y-px" />
                      
                      {/* FACE DETECTED 标签 */}
                      <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-3 py-1 bg-emerald-500/80 backdrop-blur-sm rounded-full text-xs font-mono font-bold text-white shadow-lg whitespace-nowrap">
                        FACE DETECTED
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Recording UI overlay specific to free mode */}
                {isRecording && (
                  <div className="absolute top-8 right-8 flex flex-col items-end gap-2">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/20 border border-red-500/30 rounded-lg backdrop-blur-sm">
                      <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
                      <span className="text-red-100 font-mono text-sm">REC</span>
                    </div>
                  </div>
                )}
              </div>

              {/* ASR Subtitles */}
              {isRecording && asrText && (
                <div className="absolute bottom-32 left-1/2 -translate-x-1/2 w-[80%] max-w-4xl text-center">
                  <div className="inline-block bg-black/40 backdrop-blur-md px-8 py-5 rounded-2xl border border-white/5 shadow-2xl">
                    <span className="text-2xl text-white font-semibold leading-relaxed drop-shadow-lg filter">
                      {asrText}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* --- SCRIPT MODE (Split View) --- */}
          {isScriptMode && (
            <div className="w-full h-full flex">
              {/* Left: Camera (Fixed) */}
              <div className="w-[50%] h-full relative bg-black border-r border-white/10 group overflow-hidden">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-500"
                  style={{ transform: 'scaleX(-1)' }}
                />
                {/* Cam Overlay Info */}
                <div className="absolute top-4 left-4 bg-black/40 backdrop-blur border border-white/10 px-3 py-1 rounded-full text-xs text-white/60 font-mono">
                  CAMERA FEED
                </div>

                {/* Face Box */}
                {faceBoundingBox && (
                  <div className="absolute inset-0 pointer-events-none">
                    <div
                      className="absolute border-2 border-emerald-500/60 rounded-lg shadow-[0_0_15px_rgba(16,185,129,0.4)]"
                      style={{
                        right: `${faceBoundingBox.x * 100}%`, // Mirrored top-left (so utilize right)
                        top: `${faceBoundingBox.y * 100}%`,
                        width: `${faceBoundingBox.width * 100}%`,
                        height: `${faceBoundingBox.height * 100}%`
                      }}
                    >
                      {/* 四角装饰 */}
                      <div className="absolute top-0 left-0 w-3 h-3 border-t-4 border-l-4 border-emerald-400 -translate-x-px -translate-y-px" />
                      <div className="absolute top-0 right-0 w-3 h-3 border-t-4 border-r-4 border-emerald-400 translate-x-px -translate-y-px" />
                      <div className="absolute bottom-0 left-0 w-3 h-3 border-b-4 border-l-4 border-emerald-400 -translate-x-px translate-y-px" />
                      <div className="absolute bottom-0 right-0 w-3 h-3 border-b-4 border-r-4 border-emerald-400 translate-x-px translate-y-px" />
                    </div>
                  </div>
                )}
              </div>

              {/* Right: Script (Scrollable) */}
              <div className="w-[50%] h-full bg-slate-900/50 relative">
                <div className="absolute inset-0 bg-[url('/noise.png')] opacity-5 pointer-events-none" />
                <ScriptTeleprompter content={scriptText || ''} className="h-full" />
              </div>

              {/* ASR Overlay (Centered on Camera side) */}
              {isRecording && asrText && (
                <div className="absolute bottom-32 left-[25%] -translate-x-1/2 w-[40%] text-center pointer-events-none z-20">
                  <span className="inline-block bg-black/60 backdrop-blur px-4 py-2 rounded-lg text-white text-lg">
                    {asrText}
                  </span>
                </div>
              )}
            </div>
          )}

        </div>

        {/* --- FLOATING CONTROL DOCK (Bottom) --- */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50">
          <div className="flex items-center gap-4 bg-black/40 backdrop-blur-xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-2xl p-2 pl-6 pr-2">

            {/* Timer */}
            <div className="flex flex-col items-start pr-4 border-r border-white/10 mr-2">
              <span className="text-[10px] uppercase text-white/30 tracking-widest font-bold">Duration</span>
              <span className={`font-mono text-xl ${isRecording ? 'text-red-400' : 'text-slate-400'}`}>
                {formatTime(elapsedTime)}
              </span>
            </div>

            {/* Main Action Button */}
            {!isRecording ? (
              <button
                onClick={handleStart}
                disabled={isCalibrating}
                className="group relative flex items-center justify-center w-14 h-14 bg-emerald-500 rounded-xl hover:bg-emerald-400 text-white shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-500 disabled:shadow-none"
                title={isCalibrating ? '正在校准姿态，请稍候...' : '开始练习'}
              >
                <Play className="w-6 h-6 ml-0.5 fill-current" />
              </button>
            ) : (
              <button
                onClick={handleStop}
                className="group relative flex items-center justify-center w-14 h-14 bg-red-500 rounded-xl hover:bg-red-400 text-white shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:shadow-[0_0_30px_rgba(239,68,68,0.5)] transition-all active:scale-95"
              >
                <Square className="w-6 h-6 fill-current" />
                <span className="absolute inset-0 rounded-xl border-2 border-white/20 animate-ping opacity-50" />
              </button>
            )}

            {/* TTS Toggle */}
            <button
              onClick={toggleTts}
              className={`p-4 rounded-xl transition-all border ${ttsEnabled
                ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20'
                : 'bg-white/5 border-transparent text-slate-400 hover:bg-white/10 hover:text-white'
                }`}
              title="语音教练"
            >
              {ttsEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Global Overlays */}
        {/* HUD - Floating Top Right */}
        <div className="absolute top-6 right-6 z-40 pointer-events-auto space-y-3">
          <HUD
            isRecording={isRecording}
            speed={currentSpeed}
            fillerCount={fillerCount}
            asrText={asrText}
            elapsedTime={elapsedTime}
            totalChars={(asrTranscript || '').replace(/\s+/g, '').length}
            headStatus={headStatus}
            headDownCount={headDownCount}
            lookAwayCount={lookAwayCount}
          />
          
          {/* 重新校准按钮 - 只在录制时且校准完成后显示 */}
          {isRecording && !isCalibrating && (
            <button
              onClick={() => {
                console.log('[Practice] 用户点击重新校准')
                recalibrate()
              }}
              className="w-full px-4 py-2 bg-amber-500/90 hover:bg-amber-600 text-white rounded-lg text-sm font-medium transition-all hover:scale-105 active:scale-95 shadow-lg backdrop-blur flex items-center justify-center gap-2"
              title="如果检测不准确，点击重新校准姿态基准"
            >
              <RotateCcw className="w-4 h-4" />
              重新校准
            </button>
          )}
        </div>

        {/* Camera PiP for PPT Mode (Floating Draggable) */}
        {isPPTMode && (
          <CameraPiP
            ref={cameraPiPRef}
            stream={cameraStream}
            faceBoundingBox={faceBoundingBox}
            isRecording={isRecording}
          />
        )}

        {/* Calibration Modal / Toast - 在点击开始前就显示 */}
        {isCalibrating && (
          <div className="absolute top-32 left-1/2 -translate-x-1/2 z-50">
            <div className="bg-gradient-to-br from-emerald-600 to-emerald-700 text-white px-8 py-5 rounded-2xl border-2 border-white/20 shadow-2xl">
              <div className="flex items-start gap-4">
                <div className="w-3 h-3 bg-white rounded-full animate-pulse mt-1" />
                <div className="flex-1">
                  <div className="font-bold text-lg mb-2 flex items-center gap-2">
                    <Camera className="w-5 h-5" />
                    正在校准姿态...
                  </div>
                  <div className="text-sm text-emerald-50 space-y-1">
                    <div>• 头部端正，正视镜头</div>
                    <div>• 保持自然坐姿</div>
                    <div>• 距离屏幕 50-80cm</div>
                  </div>
                  <div className="mt-3 h-2 bg-white/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-white transition-all duration-300 shadow-lg"
                      style={{ width: `${calibrationProgress}%` }}
                    />
                  </div>
                  <div className="text-xs text-emerald-100 mt-2">
                    {Math.round(calibrationProgress)}% - 还需 {Math.ceil((100 - calibrationProgress) / 33)} 秒
                  </div>
                  {!isRecording && (
                    <div className="text-xs text-emerald-100 mt-2 pt-2 border-t border-white/20">
                      校准完成后即可开始练习
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* 
        RIGHT SIDEBAR - Teleprompter (PPT Mode Only)
        Fixed width, full height, independent scroll
      */}
      {isPPTMode && (
        <div className="w-[400px] h-full border-l border-white/5 bg-slate-950/50 backdrop-blur-xl relative z-30 flex flex-col shadow-[-10px_0_40px_rgba(0,0,0,0.5)]">
          <Teleprompter
            slides={slides}
            currentIndex={currentSlideIndex}
            // User preference: teleprompter should be long-form scrolling even in PPT mode.
            // Per-slide analysis is still driven by page_turn timestamps.
            preferContinuous
          />
        </div>
      )}

      {/* Hidden tech for MediaPipe */}
      {slides.length > 0 && <video ref={videoRef} autoPlay muted className="hidden" />}
    </div>
  )
}
