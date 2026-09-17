import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import {
  Play, Pause,
  AlertCircle, AlertTriangle, Star, ChevronLeft, Download, Trash2
} from 'lucide-react'
import { motion } from 'framer-motion'
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer
} from 'recharts'
import { getReport, getVideoUrl, deleteSession, exportPdf, createWebSocket, type Event } from '../../services/api'
import { useReviewStore } from '../../stores'
import HUD from '../../components/HUD'
import useMediaPipe from '../../hooks/useMediaPipe'
import useAudioCapture from '../../hooks/useAudioCapture'
import useTypewriterText from '../../hooks/useTypewriterText'
import { uploadVideo, finishSession } from '../../services/api'

type DisplayTranscriptSegment = {
  start_ms: number
  end_ms: number
  text: string
  slide_index?: number
}

export default function ReviewPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { currentTime, selectedEventId, setCurrentTime, selectEvent } = useReviewStore()
  const location = useLocation() as any

  const localVideoFile: File | null = location?.state?.localVideoFile || null

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Awaited<ReturnType<typeof getReport>> | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState<{ progress: number; stage: string; message?: string } | null>(null)
  const [viewingSlideIndex, setViewingSlideIndex] = useState<number | null>(null)
  const [showAllSlides, setShowAllSlides] = useState(false)

  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null)
  const [asrText, setAsrText] = useState('')
  const [currentSpeed, setCurrentSpeed] = useState(0)
  const [fillerCount, setFillerCount] = useState(0)
  const [realtimeOutline, setRealtimeOutline] = useState<any[]>([])
  const [durationMs, setDurationMs] = useState(0)
  const [realtimeTranscriptSegments, setRealtimeTranscriptSegments] = useState<DisplayTranscriptSegment[]>([])

  // Separate websockets to avoid handler/data races:
  // - analysisWsRef: server-side analysis progress/report updates
  // - realtimeWsRef: upload playback realtime ASR + coaching events
  const analysisWsRef = useRef<WebSocket | null>(null)
  const realtimeWsRef = useRef<WebSocket | null>(null)

  const realtimeActiveRef = useRef(false)
  const realtimeStartTokenRef = useRef(0)
  const realtimeAsrStartedRef = useRef(false)
  const realtimeHasPlayedRef = useRef(false)
  const realtimePcmQueueRef = useRef<ArrayBuffer[]>([])
  const realtimePcmDroppedRef = useRef(0)
  const realtimeCaptureStartedRef = useRef(false)
  const realtimeAsrOffsetMsRef = useRef(0)
  const realtimeAsrMsgCounterRef = useRef(0)
  const headDownStartRef = useRef<number | null>(null)
  const lookAwayStartRef = useRef<number | null>(null)

  // Body sway tracking (Pose) - upload playback
  const swayWindowRef = useRef<Array<{ t: number; x: number; y: number }>>([])
  const swayCooldownRef = useRef<number>(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const elementAudioCtxRef = useRef<AudioContext | null>(null)
  const elementAudioSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const elementAudioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null)

  const uploadPcmSendCounterRef = useRef(0)

  // Avoid effect churn: store hook functions in refs
  const startCaptureRef = useRef<(() => Promise<void>) | null>(null)
  const stopCaptureRef = useRef<(() => void) | null>(null)
  const startDetectionRef = useRef<((video: HTMLVideoElement) => void) | null>(null)
  const stopDetectionRef = useRef<(() => void) | null>(null)
  const mediaPipeReadyRef = useRef(false)

  const onUploadAudioData = useCallback((pcmData: ArrayBuffer) => {
    // If ASR hasn't been started yet, queue a little bit so we can flush right after start_asr.
    if (!realtimeAsrStartedRef.current) {
      const q = realtimePcmQueueRef.current
      if (q.length < 10) q.push(pcmData)
      else realtimePcmDroppedRef.current += 1
      return
    }

    const ws = realtimeWsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(pcmData)
      uploadPcmSendCounterRef.current += 1
      const n = uploadPcmSendCounterRef.current
      if (n === 1 || n % 50 === 0) {
        console.log('[upload-asr] sent pcm chunks=', n, 'bytes=', pcmData.byteLength)
      }
      return
    }

    // Queue a small amount until WS opens
    const q = realtimePcmQueueRef.current
    if (q.length < 30) {
      q.push(pcmData)
    } else {
      realtimePcmDroppedRef.current += 1
    }
  }, [])

  const getUploadAudioStream = useCallback(async (): Promise<MediaStream> => {
    const video = videoRef.current
    if (!video) throw new Error('Video element not ready')
    // captureStream is supported in Chromium/Edge
    const anyVideo: any = video as any
    const stream: MediaStream | undefined = anyVideo.captureStream?.() || anyVideo.mozCaptureStream?.()
    if (stream) {
      const n = stream.getAudioTracks().length
      console.log('[upload-asr] captureStream audioTracks=', n)
      if (n > 0) return stream
    }

    // Fallback: route media element audio through WebAudio to create a capturable stream.
    console.log('[upload-asr] falling back to WebAudio MediaElementSource')
    if (!elementAudioCtxRef.current) {
      elementAudioCtxRef.current = new AudioContext()
    }
    const ctx = elementAudioCtxRef.current
    if (!elementAudioSourceRef.current) {
      elementAudioSourceRef.current = ctx.createMediaElementSource(video)
      // Keep audible playback
      elementAudioSourceRef.current.connect(ctx.destination)
    }

    // Destination stream may have been stopped by previous capture; recreate if needed.
    const existingDest = elementAudioDestRef.current
    const existingTrack = existingDest?.stream?.getAudioTracks?.()[0]
    if (!existingDest || !existingTrack || existingTrack.readyState === 'ended') {
      elementAudioDestRef.current = ctx.createMediaStreamDestination()
      elementAudioSourceRef.current.connect(elementAudioDestRef.current)
    }

    try {
      if (ctx.state !== 'running') await ctx.resume()
    } catch {
      // ignore
    }

    const dest = elementAudioDestRef.current
    const out = dest?.stream
    if (!out || out.getAudioTracks().length === 0) {
      throw new Error('No audio track available')
    }
    return out
  }, [])

  const sendRealtimeEvent = useCallback((payload: any) => {
    const ws = (realtimeWsRef.current?.readyState === WebSocket.OPEN)
      ? realtimeWsRef.current
      : (analysisWsRef.current?.readyState === WebSocket.OPEN ? analysisWsRef.current : null)
    if (!ws) return
    ws.send(JSON.stringify({ type: 'event', data: payload }))
  }, [])

  // MediaPipe hook (for upload analysis playback)
  const { isReady: mediaPipeReady, startDetection, stopDetection } = useMediaPipe({
    maxFps: 10,
    delegate: 'CPU',
    onPoseUpdate: (landmarks) => {
      if (!localVideoFile) return
      const v = videoRef.current
      if (!v) return
      if (!Array.isArray(landmarks) || landmarks.length < 13) return

      const nowMs = Math.round((v.currentTime || 0) * 1000)
      const leftShoulder = landmarks[11]
      const rightShoulder = landmarks[12]
      if (!leftShoulder || !rightShoulder) return

      const cx = (leftShoulder.x + rightShoulder.x) / 2
      const cy = (leftShoulder.y + rightShoulder.y) / 2

      const buf = swayWindowRef.current
      buf.push({ t: nowMs, x: cx, y: cy })
      while (buf.length > 0 && nowMs - buf[0].t > 4000) buf.shift()
      if (buf.length < 8) return

      const xs = buf.map(p => p.x)
      const xRange = Math.max(...xs) - Math.min(...xs)
      const SWAY_X_RANGE = 0.10
      const now = Date.now()
      if (xRange >= SWAY_X_RANGE && now - swayCooldownRef.current > 12000) {
        swayCooldownRef.current = now
        const start = buf[0].t
        const end = buf[buf.length - 1].t
        sendRealtimeEvent({
          session_id: sessionId!,
          type: 'issue',
          category: 'body_sway',
          severity: 'medium',
          start_ms: start,
          end_ms: end,
          evidence: { x_range: xRange, threshold_x_range: SWAY_X_RANGE },
        })
      }
    },
    onHeadPose: (pitch, yaw, roll) => {
      if (!localVideoFile) return
      const nowMs = Math.round((videoRef.current?.currentTime || 0) * 1000)
      const isHeadDown = pitch < -12
      const isLookAway = Math.abs(yaw) > 15

      if (isHeadDown) {
        if (headDownStartRef.current === null) headDownStartRef.current = nowMs
        const duration = nowMs - headDownStartRef.current
        if (duration >= 6000) {
          const ev = {
            session_id: sessionId!,
            type: 'issue',
            category: 'head_down',
            severity: 'high',
            start_ms: headDownStartRef.current,
            end_ms: nowMs,
            evidence: { duration_ms: duration, pitch, yaw, roll, threshold_pitch_deg: -12 },
          }
          sendRealtimeEvent(ev)
          headDownStartRef.current = nowMs
        }
      } else {
        headDownStartRef.current = null
      }

      if (isLookAway) {
        if (lookAwayStartRef.current === null) lookAwayStartRef.current = nowMs
        const duration = nowMs - lookAwayStartRef.current
        if (duration >= 8000) {
          const ev = {
            session_id: sessionId!,
            type: 'issue',
            category: 'look_away',
            severity: 'high',
            start_ms: lookAwayStartRef.current,
            end_ms: nowMs,
            evidence: { duration_ms: duration, pitch, yaw, roll, threshold_yaw_deg: 15 },
          }
          sendRealtimeEvent(ev)
          lookAwayStartRef.current = nowMs
        }
      } else {
        lookAwayStartRef.current = null
      }
    },
  })

  // Audio capture (for upload analysis playback)
  const { startCapture, stopCapture } = useAudioCapture({
    onAudioData: onUploadAudioData,
    getStream: getUploadAudioStream,
  })

  useEffect(() => {
    startCaptureRef.current = startCapture
  }, [startCapture])

  useEffect(() => {
    stopCaptureRef.current = stopCapture
  }, [stopCapture])

  useEffect(() => {
    startDetectionRef.current = startDetection
    stopDetectionRef.current = stopDetection
    mediaPipeReadyRef.current = mediaPipeReady
  }, [startDetection, stopDetection, mediaPipeReady])

  useEffect(() => {
    if (!sessionId) return

    async function loadReport() {
      try {
        const report = await getReport(sessionId!)
        setData(report)

        // Hydrate streaming state for resuming users
        if (report?.session?.status === 'analyzing' && report?.slides) {
          const existing = report.slides
            .filter((s: any) => s.analysis)
            .map((s: any) => ({ ...s.analysis, slide_index: s.slide_index || s.index }))
            .sort((a: any, b: any) => a.slide_index - b.slide_index)

          if (existing.length > 0) {
            setRealtimeOutline(existing)
          }
        }

        // Also hydrate for completed sessions that have slides with analysis
        if (report?.session?.mode === 'ppt_analysis' && report?.slides) {
          const existing = report.slides
            .filter((s: any) => s.analysis)
            .map((s: any) => ({ ...s.analysis, slide_index: s.slide_index || s.index }))
            .sort((a: any, b: any) => a.slide_index - b.slide_index)

          if (existing.length > 0) {
            setRealtimeOutline(existing)
          }
        }

        setLoading(false)
      } catch (err) {
        console.error('Failed to load report:', err)
        setLoading(false)
      }
    }

    loadReport()
  }, [sessionId])

  // Prefer backend duration_ms, but fall back to video metadata
  useEffect(() => {
    const backendDuration = (data?.session as any)?.duration_ms
    if (typeof backendDuration === 'number' && backendDuration > 0) {
      setDurationMs(backendDuration)
    }
  }, [data?.session])

  const subtitleText = useMemo(() => {
    if (localVideoFile) return asrText
    const segments = (data as any)?.transcript_segments || []
    if (!Array.isArray(segments) || segments.length === 0) return ''
    const t = currentTime
    // Find current segment (linear scan is fine for typical sizes)
    const seg = segments.find((s: any) => t >= (s.start_ms ?? 0) && t <= (s.end_ms ?? 0))
    if (seg?.text) return String(seg.text)
    // Fallback: show latest segment before current time
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i]
      if (t >= (s.end_ms ?? 0) && s?.text) return String(s.text)
    }
    return ''
  }, [localVideoFile, asrText, data, currentTime])

  const animatedSubtitleText = useTypewriterText(subtitleText)

  // Local video URL lifecycle (upload analysis mode)
  useEffect(() => {
    if (!localVideoFile) return
    const url = URL.createObjectURL(localVideoFile)
    setLocalVideoUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [localVideoFile])

  // Background upload + trigger analysis (upload analysis mode)
  useEffect(() => {
    if (!sessionId) return
    if (!localVideoFile) return

    let cancelled = false
      ; (async () => {
        try {
          await uploadVideo(sessionId, localVideoFile, localVideoFile.name)
          if (cancelled) return
          await finishSession(sessionId)
        } catch (e) {
          // ignore; report page will show failure on load/report
        }
      })()

    return () => {
      cancelled = true
    }
  }, [sessionId, localVideoFile])



  // Progressive analysis updates via WebSocket
  useEffect(() => {
    if (!sessionId) return
    if (!data?.session) return
    if (data.session.status === 'completed' || data.session.status === 'error') return

    const ws = createWebSocket(sessionId)
    analysisWsRef.current = ws
    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data)
        // Handle both regular analysis and PPT analysis progress
        if (msg?.type === 'analysis.progress' || msg?.type === 'ppt_analysis.progress') {
          setAnalysisProgress({
            progress: msg.progress ?? 0,
            message: msg.message,
            stage: msg.stage,
          })
        }

        // Handle streaming slide completion
        if (msg?.type === 'ppt_analysis.slide_completed' && msg.result) {
          setRealtimeOutline(prev => {
            if (prev.some(p => p.slide_index === msg.result.slide_index)) return prev
            return [...prev, msg.result].sort((a, b) => (a.slide_index ?? 0) - (b.slide_index ?? 0))
          })
        }


        if (msg?.type === 'report.event' && msg?.event) {
          setData((prev) => {
            if (!prev) return prev
            const incoming = msg.event
            const incomingId = incoming?.id
            const exists = incomingId
              ? prev.events.some((e: any) => e.id === incomingId)
              : false
            if (exists) return prev
            return {
              ...prev,
              events: [...prev.events, incoming],
            } as any
          })
        }
        if (msg?.type === 'report.ready') {
          const report = await getReport(sessionId)
          setData(report)
        }
      } catch {
        // ignore
      }
    }

    return () => {
      ws.close()
      if (analysisWsRef.current === ws) analysisWsRef.current = null
    }
  }, [sessionId, data?.session?.status])

  // Realtime coaching during upload analysis playback (ASR + MediaPipe)
  // Keep this effect stable (avoid dependency churn causing repeated stop/start)
  useEffect(() => {
    if (!localVideoFile) return
    if (!sessionId) return
    if (loading) return
    const video = videoRef.current
    if (!video) return

    const flushQueuedPcm = () => {
      const ws = realtimeWsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const q = realtimePcmQueueRef.current
      if (q.length > 0) {
        for (const buf of q.splice(0, q.length)) {
          ws.send(buf)
          uploadPcmSendCounterRef.current += 1
        }
        const dropped = realtimePcmDroppedRef.current
        if (dropped > 0) {
          console.log('[upload-asr] dropped pcm chunks before open=', dropped)
          realtimePcmDroppedRef.current = 0
        }
      }
    }

    const ensureCapture = async () => {
      if (realtimeCaptureStartedRef.current) return
      try {
        await startCaptureRef.current?.()
        realtimeCaptureStartedRef.current = true
      } catch {
        // ignore
      }
    }

    const startAsrOnly = () => {
      const ws = realtimeWsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (!shouldRealtime()) return
      const offset = Math.round(video.currentTime * 1000)
      realtimeAsrOffsetMsRef.current = offset
      ws.send(JSON.stringify({ type: 'start_asr', time_offset_ms: offset }))
      realtimeAsrStartedRef.current = true
      flushQueuedPcm()
    }

    const stopAsrOnly = () => {
      if (realtimeAsrStartedRef.current && realtimeWsRef.current?.readyState === WebSocket.OPEN) {
        realtimeWsRef.current.send(JSON.stringify({ type: 'stop_asr' }))
      }
      realtimeAsrStartedRef.current = false
    }

    const ensureWs = () => {
      const existing = realtimeWsRef.current
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return
      const ws = createWebSocket(sessionId)
      realtimeWsRef.current = ws
      ws.addEventListener('open', () => {
        flushQueuedPcm()
      })
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg?.type?.startsWith?.('asr.')) {
            realtimeAsrMsgCounterRef.current += 1
            const n = realtimeAsrMsgCounterRef.current
            if (n <= 5) console.log('[upload-asr] recv', msg.type, msg.text)
          }
          if (msg?.type === 'asr.mid_text') setAsrText((msg.text || '').trim())
          if (msg?.type === 'asr.fin_text') {
            const finalText = (msg.text || '').trim()
            if (finalText) {
              setAsrText(finalText)
              const start = Number.isFinite(msg.start_ms) ? Number(msg.start_ms) : 0
              const end = Number.isFinite(msg.end_ms) ? Number(msg.end_ms) : 0
              const offset = realtimeAsrOffsetMsRef.current || 0
              const segment: DisplayTranscriptSegment = {
                start_ms: Math.max(0, start + offset),
                end_ms: Math.max(0, end + offset),
                text: finalText,
                slide_index: undefined
              }
              setRealtimeTranscriptSegments((prev) => {
                const last = prev[prev.length - 1]
                if (last && last.text === segment.text && last.start_ms === segment.start_ms && last.end_ms === segment.end_ms) {
                  return prev
                }
                return [...prev, segment]
              })
            }
            const durationMin = Math.max(1e-6, (msg.end_ms - msg.start_ms) / 1000 / 60)
            const cpm = Math.round((msg.text || '').length / durationMin)
            setCurrentSpeed(cpm)
          }
          if (msg?.type === 'report.event' && msg?.event?.category === 'filler_word') {
            setFillerCount((c) => c + 1)
          }
        } catch {
          // ignore
        }
      }
      ws.addEventListener('close', () => {
        if (realtimeWsRef.current === ws) realtimeWsRef.current = null
      })
    }

    const startRealtime = async () => {
      realtimeActiveRef.current = true
      const token = ++realtimeStartTokenRef.current
      ensureWs()
      const ws = realtimeWsRef.current
      if (!ws) return
      const startWhenOpen = async () => {
        if (!realtimeActiveRef.current) return
        if (token !== realtimeStartTokenRef.current) return
        if (!shouldRealtime()) return
        await ensureCapture()
        startAsrOnly()
        if (mediaPipeReadyRef.current) {
          try {
            startDetectionRef.current?.(video)
          } catch {
            // ignore
          }
        }
      }
      if (ws.readyState === WebSocket.OPEN) {
        await startWhenOpen()
      } else {
        ws.addEventListener('open', () => {
          startWhenOpen()
        }, { once: true })
      }
    }

    const stopRealtime = () => {
      realtimeActiveRef.current = false
      try {
        stopCaptureRef.current?.()
      } catch {
        // ignore
      }
      realtimeCaptureStartedRef.current = false
      try {
        stopDetectionRef.current?.()
      } catch {
        // ignore
      }
      stopAsrOnly()
    }

    const shouldRealtime = () => {
      const isSeeking = (video as any).seeking
      const rate = video.playbackRate || 1
      return !isSeeking && rate === 1 && !video.paused && !video.ended
    }

    const handlePlay = () => {
      realtimeHasPlayedRef.current = true
      if (shouldRealtime()) startRealtime()
    }
    const handlePause = () => stopRealtime()
    const handleEnded = () => stopRealtime()
    const handleSeeking = () => {
      if (!realtimeHasPlayedRef.current) return
      // Seeking happens frequently during buffering; do not tear down AudioContext.
      stopAsrOnly()
      try {
        stopDetectionRef.current?.()
      } catch {
        // ignore
      }
    }
    const handleSeeked = () => {
      if (!shouldRealtime()) return
      ensureWs()
      ensureCapture().then(() => {
        startAsrOnly()
        if (mediaPipeReadyRef.current) {
          try {
            startDetectionRef.current?.(video)
          } catch {
            // ignore
          }
        }
      })
    }
    const handleRateChange = () => {
      // Pause ASR on non-1x, but keep capture to avoid churn.
      if (shouldRealtime()) {
        ensureWs()
        ensureCapture().then(() => {
          startAsrOnly()
          if (mediaPipeReadyRef.current) {
            try {
              startDetectionRef.current?.(video)
            } catch {
              // ignore
            }
          }
        })
      } else {
        stopAsrOnly()
      }
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('ended', handleEnded)
    video.addEventListener('seeking', handleSeeking)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('ratechange', handleRateChange)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('ended', handleEnded)
      video.removeEventListener('seeking', handleSeeking)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('ratechange', handleRateChange)
      stopRealtime()
      try {
        if (realtimeWsRef.current?.readyState === WebSocket.OPEN) {
          realtimeWsRef.current.close()
        }
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localVideoFile, sessionId, loading])

  // Video time sync - must run after video source is set
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime * 1000)
      // 如果 durationMs 还没设置，但视频已有 duration，就更新它
      if (durationMs === 0 && Number.isFinite(video.duration) && video.duration > 0) {
        setDurationMs(Math.round(video.duration * 1000))
      }
    }

    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)

    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
    }
  }, [setCurrentTime, localVideoUrl, data, durationMs])

  const handleEventClick = (event: Event) => {
    selectEvent(event.id)
    if (videoRef.current) {
      videoRef.current.currentTime = event.start_ms / 1000
      videoRef.current.play()
      setIsPlaying(true)
    }
  }

  const handlePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause()
      } else {
        videoRef.current.play()
      }
    }
  }

  const handleDelete = async () => {
    if (!confirm('确定要删除这次练习记录吗？删除后无法恢复。')) return

    try {
      await deleteSession(sessionId!)
      window.location.href = '/history'
    } catch (err) {
      alert('删除失败')
    }
  }

  const handleExportPdf = async () => {
    if (!sessionId) return
    setExportingPdf(true)
    try {
      const res = await exportPdf(sessionId)
      // Trigger browser download/open (same-origin /api)
      window.open(res.url, '_blank')
    } catch (err) {
      alert('导出 PDF 失败')
    } finally {
      setExportingPdf(false)
    }
  }

  // Loading tips for fun waiting experience
  const loadingTips = [
    '好的开场能抓住听众注意力',
    '每页 PPT 尽量只讲一个核心观点',
    '适当控制时长，保持节奏紧凑',
    '手势能让表达更有感染力',
    '与听众保持眼神交流，增强说服力',
    '适当停顿比快速说完更有力量',
    '数据与故事结合更能打动人心',
    '自信的语气能显著提升说服力',
  ]
  const [tipIndex, setTipIndex] = useState(0)

  useEffect(() => {
    if (!loading) return
    const interval = setInterval(() => {
      setTipIndex(i => (i + 1) % loadingTips.length)
    }, 3000)
    return () => clearInterval(interval)
  }, [loading])

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="text-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            className="w-16 h-16 mx-auto mb-6 rounded-full border-4 border-primary/20 border-t-primary"
          />
          <div className="text-lg font-medium text-primary mb-2">AI 正在分析中...</div>
          <motion.div
            key={tipIndex}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="text-sm text-neutral-500 max-w-xs mx-auto"
          >
            {loadingTips[tipIndex]}
          </motion.div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="text-red-500">加载报告失败</div>
      </div>
    )
  }

  const { session, report, events, transcript_segments, metrics } = data
  const displayTranscriptSegments = localVideoFile ? realtimeTranscriptSegments : transcript_segments
  const isPptPrepOnly = session.mode === 'ppt_analysis'
  const pptPrep = (session.mode === 'ppt_analysis' && session.status === 'analyzing' && realtimeOutline.length > 0)
    ? {
      outline: realtimeOutline,
      scores: undefined,
      suggestions: ["AI 正在逐页分析您的 PPT，请稍候..."],
      overall_structure: "正在根据上下文生成连贯的演讲逻辑...",
      estimated_total_duration_sec: realtimeOutline.reduce((a, b: any) => a + (b.estimated_duration_sec || 0), 0)
    }
    : report?.ppt_prep as any
  const scores = report?.scores || { total: 0, fluency: 0, nonverbal: 0, emotion: 0, structure: 0 }

  const radarData = [
    { subject: '逻辑', value: (scores as any).logic ?? scores.structure, fullMark: 100 },
    { subject: '流畅度', value: scores.fluency, fullMark: 100 },
    { subject: '肢体', value: (scores as any).delivery ?? scores.nonverbal, fullMark: 100 },
    { subject: '情感', value: scores.emotion, fullMark: 100 },
    { subject: '节奏', value: (scores as any).pacing ?? scores.structure, fullMark: 100 },
  ]

  const issues = events.filter(e => e.type === 'issue')
  const highlights = events.filter(e => e.type === 'highlight')

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  const safeDurationMs = Math.max(1, durationMs || (session.duration_ms || 0) || 1)
  const progressPct = Math.min(100, Math.max(0, (currentTime / safeDurationMs) * 100))
  const slidesSummary = data.slides_summary || []

  const stageLabel = (stage?: string) => {
    const map: Record<string, string> = {
      start: '准备分析',
      extract_audio: '提取音频',
      audio_features: '分析音频特征',
      extract_frames: '提取关键帧',
      glm_frames: '分析关键帧',
      scoring: '计算评分',
      suggestions: '生成建议',
      done: '完成',
    }
    return (stage && map[stage]) || '分析中'
  }

  const handleSlideSummaryClick = (slideIndex?: number) => {
    if (!slideIndex) return
    const slide = (data.slides || []).find(s => (s as any).slide_index === slideIndex || (s as any).index === slideIndex)
    const startMs = (slide as any)?.start_ms
    if (videoRef.current && typeof startMs === 'number' && startMs >= 0) {
      videoRef.current.currentTime = startMs / 1000
      videoRef.current.play()
      setIsPlaying(true)
    }
  }

  // PPT Analysis mode: Show analyzing state with progress
  if (session.mode === 'ppt_analysis' && session.status === 'analyzing' && realtimeOutline.length === 0) {
    const progressPct = analysisProgress?.progress ?? 0
    const message = analysisProgress?.message || '正在分析 PPT...'

    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-6">
          {/* Animated spinner */}
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            className="w-20 h-20 mx-auto mb-8 rounded-full border-4 border-primary/20 border-t-primary"
          />

          {/* Title */}
          <h2 className="text-2xl font-bold text-primary mb-4">
            AI 正在分析您的 PPT
          </h2>

          {/* Progress bar */}
          <div className="w-full bg-neutral-200 rounded-full h-3 mb-4 overflow-hidden shadow-inner">
            <motion.div
              className="bg-gradient-to-r from-primary to-primary-light h-full rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(5, progressPct)}%` }}
              transition={{ duration: 1.5, ease: "easeInOut" }}
            />
          </div>

          {/* Progress info */}
          <div className="text-lg font-medium text-primary mb-2">
            {progressPct}%
          </div>
          <div className="text-sm text-neutral-500 mb-8 min-h-[1.5em]">
            {message}
          </div>

          {/* Background Run Button */}
          <button
            onClick={() => {
              window.location.href = '/'
            }}
            className="mb-8 text-sm text-neutral-500 hover:text-primary transition-colors underline underline-offset-4"
          >
            不想等待？点击此处在后台继续分析，稍后在记录中查看
          </button>

          {/* Tips */}
          <motion.div
            key={tipIndex}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="text-sm text-neutral-400 italic bg-neutral-100 py-2 px-4 rounded-full inline-block"
          >
            {loadingTips[tipIndex]}
          </motion.div>
        </div>
      </div>
    )
  }

  if (isPptPrepOnly) {
    const totalSec = pptPrep?.estimated_total_duration_sec
    const totalMin = typeof totalSec === 'number' && totalSec > 0 ? Math.round(totalSec / 60) : null
    return (
      <div className="min-h-screen bg-neutral-50 py-8">
        <div className="max-w-5xl mx-auto px-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-4">
              <Link to="/history" className="p-2 rounded-xl bg-white shadow-soft hover:shadow-glass">
                <ChevronLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-primary">{session.title || 'PPT 分析报告'}</h1>
                <p className="text-sm text-neutral-500">{new Date(session.created_at).toLocaleString('zh-CN')}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleExportPdf}
                disabled={exportingPdf}
                className="btn-secondary flex items-center gap-2 disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                {exportingPdf ? '导出中...' : '导出 PDF'}
              </button>
              <button
                onClick={handleDelete}
                className="p-3 rounded-xl bg-white shadow-soft hover:bg-red-50 text-neutral-600 hover:text-red-500"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="space-y-6">
            {/* Realtime Analysis Progress Header */}
            {session.status === 'analyzing' && (
              <div className="p-4 rounded-xl bg-gradient-to-r from-purple-50 to-white border border-purple-100 shadow-sm flex items-center gap-4">
                <div className="relative">
                  <div className="w-10 h-10 rounded-full border-2 border-purple-200 border-t-purple-600 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-purple-600">
                    {analysisProgress?.progress || 0}%
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-purple-900 truncate">
                    {analysisProgress?.message || '正在深度分析您的 PPT...'}
                  </h3>
                  <p className="text-xs text-purple-500 mt-1">
                    AI 正在阅读每一页内容并生成专属演讲稿，已完成页面将自动显示。
                  </p>
                </div>
                <div className="hidden sm:block">
                  <button
                    className="text-xs text-neutral-400 hover:text-purple-600 underline"
                    onClick={() => window.location.href = '/'}
                  >后台运行</button>
                </div>
              </div>
            )}

            {/* PPT Slides Preview */}
            {(data.slides?.length || 0) > 0 && (
              <details className="card group">
                <summary className="font-semibold text-primary cursor-pointer flex items-center justify-between">
                  <span>PPT 页面预览 ({data.slides?.length || 0} 页) - 点击可放大查看</span>
                  <span className="text-xs text-neutral-400 group-open:rotate-180 transition-transform">▼</span>
                </summary>
                <div className="mt-4 grid grid-cols-4 gap-3">
                  {data.slides?.map((slide: any, i: number) => (
                    <div
                      key={i}
                      className="rounded-lg overflow-hidden border border-neutral-200 bg-white cursor-pointer hover:ring-2 hover:ring-primary transition-all"
                      onClick={() => setViewingSlideIndex(i)}
                    >
                      <img
                        src={`/api/sessions/${sessionId}/slides/${slide.index || i + 1}/image`}
                        alt={`第 ${slide.index || i + 1} 页`}
                        className="w-full aspect-[4/3] object-cover"
                      />
                      <div className="px-2 py-1 text-xs text-neutral-500 text-center">第 {slide.index || i + 1} 页</div>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Slide Viewer Modal */}
            {viewingSlideIndex !== null && data.slides && (
              <div
                className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
                onClick={() => setViewingSlideIndex(null)}
              >
                <div className="relative max-w-5xl w-full mx-4" onClick={e => e.stopPropagation()}>
                  <img
                    src={`/api/sessions/${sessionId}/slides/${data.slides[viewingSlideIndex]?.index || viewingSlideIndex + 1}/image`}
                    alt={`第 ${viewingSlideIndex + 1} 页`}
                    className="w-full rounded-lg shadow-2xl"
                  />
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-black/50 rounded-full px-6 py-2">
                    <button
                      onClick={() => setViewingSlideIndex(Math.max(0, viewingSlideIndex - 1))}
                      disabled={viewingSlideIndex === 0}
                      className="text-white disabled:opacity-30 hover:text-primary transition-colors text-lg"
                    >
                      ◀ 上一页
                    </button>
                    <span className="text-white text-sm">
                      {viewingSlideIndex + 1} / {data.slides.length}
                    </span>
                    <button
                      onClick={() => setViewingSlideIndex(Math.min(data.slides!.length - 1, viewingSlideIndex + 1))}
                      disabled={viewingSlideIndex === data.slides.length - 1}
                      className="text-white disabled:opacity-30 hover:text-primary transition-colors text-lg"
                    >
                      下一页 ▶
                    </button>
                  </div>
                  <button
                    onClick={() => setViewingSlideIndex(null)}
                    className="absolute top-4 right-4 text-white text-2xl hover:text-primary"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* PPT Scores */}
            {pptPrep?.scores && (
              <div className="card">
                <div className="flex flex-col md:flex-row gap-6">
                  {/* Total Score */}
                  <div className="text-center md:w-1/3">
                    <div className="text-6xl font-bold text-primary mb-2">
                      {Math.round(pptPrep.scores.total ?? 70)}
                    </div>
                    <div className="text-neutral-500">PPT 综合评分</div>
                    <div className={`text-sm mt-1 ${(pptPrep.scores.total ?? 0) >= 90 ? 'text-accent-success' :
                      (pptPrep.scores.total ?? 0) >= 75 ? 'text-primary' :
                        (pptPrep.scores.total ?? 0) >= 60 ? 'text-yellow-600' : 'text-red-500'
                      }`}>
                      {(pptPrep.scores.total ?? 0) >= 90 ? '优秀' :
                        (pptPrep.scores.total ?? 0) >= 75 ? '良好' :
                          (pptPrep.scores.total ?? 0) >= 60 ? '一般' : '需改进'}
                    </div>
                  </div>

                  {/* Dimension Scores */}
                  <div className="flex-1 space-y-3">
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-neutral-600">结构完整性</span>
                        <span className="font-medium text-primary">{pptPrep.scores.structure ?? 70}</span>
                      </div>
                      <div className="h-2 bg-neutral-200 rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pptPrep.scores.structure ?? 70}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-neutral-600">逻辑流畅度</span>
                        <span className="font-medium text-primary">{pptPrep.scores.logic ?? 70}</span>
                      </div>
                      <div className="h-2 bg-neutral-200 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pptPrep.scores.logic ?? 70}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-neutral-600">内容丰富度</span>
                        <span className="font-medium text-primary">{pptPrep.scores.content ?? 70}</span>
                      </div>
                      <div className="h-2 bg-neutral-200 rounded-full overflow-hidden">
                        <div className="h-full bg-purple-500 rounded-full transition-all" style={{ width: `${pptPrep.scores.content ?? 70}%` }} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Improvement Areas */}
                {Array.isArray(pptPrep.improvement_areas) && pptPrep.improvement_areas.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-neutral-100">
                    <div className="text-xs text-neutral-500 mb-2">可重点提升</div>
                    <div className="flex flex-wrap gap-2">
                      {pptPrep.improvement_areas.map((area: string, i: number) => (
                        <span key={i} className="px-3 py-1 bg-yellow-50 text-yellow-700 text-sm rounded-full border border-yellow-200">
                          {area}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="card">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-semibold text-primary">整体结构建议</div>
                  {pptPrep?.deck_storyline && (
                    <div className="text-sm text-neutral-700 mt-2">
                      <span className="font-medium">主线：</span>{pptPrep.deck_storyline}
                    </div>
                  )}
                  {pptPrep?.overall_structure && (
                    <div className="text-sm text-neutral-600 mt-2">{pptPrep.overall_structure}</div>
                  )}
                </div>
                <div className="text-sm text-neutral-500">
                  预计总时长：{totalMin ? `${totalMin} 分钟` : '—'}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="font-semibold text-primary mb-3">可执行建议</div>
              {pptPrep?.suggestions?.length ? (
                <ul className="list-disc pl-5 space-y-2 text-sm text-neutral-600">
                  {pptPrep.suggestions.slice(0, 8).map((s: string, idx: number) => (
                    <li key={idx}>{s}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-neutral-500">暂无建议</div>
              )}
            </div>

            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <div className="font-semibold text-primary">逐页讲述要点</div>
                {(pptPrep?.outline?.length ?? 0) > 4 && (
                  <button
                    onClick={() => setShowAllSlides(!showAllSlides)}
                    className="text-sm text-primary hover:text-primary-light transition-colors flex items-center gap-1"
                  >
                    {showAllSlides ? '收起' : `展开全部 (${pptPrep?.outline?.length ?? 0} 页)`}
                    <span className={`transition-transform ${showAllSlides ? 'rotate-180' : ''}`}>▼</span>
                  </button>
                )}
              </div>
              {pptPrep?.outline?.length ? (
                <div className="space-y-4">
                  {(showAllSlides ? pptPrep.outline : pptPrep.outline.slice(0, 4)).map((o: any, idx: number) => (
                    <div key={idx} className="p-4 rounded-xl bg-neutral-50 hover:bg-neutral-100 transition-colors border border-neutral-100">
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                        {/* Left: Slide Threshold & Info */}
                        <div className="md:col-span-4 flex flex-col gap-2">
                          <div className="rounded-lg overflow-hidden border border-neutral-200 shadow-sm bg-white aspect-[4/3] relative group">
                            <img
                              src={`/api/sessions/${sessionId}/slides/${o.slide_index ?? idx + 1}/image`}
                              alt={`第 ${o.slide_index ?? idx + 1} 页`}
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-xs py-1 px-2 text-center opacity-0 group-hover:opacity-100 transition-opacity">
                              点击放大
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="font-bold text-primary text-sm">第 {o.slide_index ?? idx + 1} 页</div>
                            <div className="text-xs text-neutral-500 mt-1">
                              {o.page_type && <span className="mr-2 uppercase px-1.5 py-0.5 bg-neutral-200 rounded text-[10px]">{o.page_type}</span>}
                              {typeof o.estimated_duration_sec === 'number' ? `约 ${Math.round(o.estimated_duration_sec)} 秒` : ''}
                            </div>
                          </div>
                        </div>

                        {/* Right: Analysis & Content */}
                        <div className="md:col-span-8 flex flex-col gap-3">
                          {o.title && <h3 className="font-bold text-neutral-800">{o.title}</h3>}

                          {/* Key Points */}
                          {Array.isArray(o.key_points) && o.key_points.length > 0 && (
                            <div className="bg-white p-3 rounded-lg border border-neutral-200">
                              <div className="text-xs font-semibold text-neutral-500 mb-2 uppercase">核心要点</div>
                              <ul className="list-disc pl-5 space-y-1 text-sm text-neutral-700">
                                {o.key_points.slice(0, 6).map((kp: any, kpi: number) => {
                                  if (typeof kp === 'object' && kp !== null && kp.section_title) {
                                    return (
                                      <li key={kpi} className="list-none -ml-5 mb-1">
                                        <div className="font-medium text-neutral-800 text-xs mt-1">{kp.section_title}</div>
                                        {Array.isArray(kp.points) && (
                                          <ul className="list-disc pl-5 space-y-0.5 mt-1">
                                            {kp.points.map((pt: string, pti: number) => <li key={pti}>{pt}</li>)}
                                          </ul>
                                        )}
                                      </li>
                                    )
                                  }
                                  return <li key={kpi}>{String(kp)}</li>
                                })}
                              </ul>
                            </div>
                          )}

                          {/* Tips & Script */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {/* Speaking Tips */}
                            {o.speaking_tips && (
                              <div className="p-2 bg-blue-50 rounded-lg border border-blue-100">
                                <div className="text-xs font-medium text-blue-600 mb-1">讲解技巧</div>
                                <div className="text-xs text-blue-700 leading-relaxed">{o.speaking_tips}</div>
                              </div>
                            )}

                            {/* Transition & Interaction */}
                            <div className="p-2 bg-green-50 rounded-lg border border-green-100 flex flex-col gap-2">
                              {o.transition_hint && (
                                <div>
                                  <div className="text-xs font-medium text-green-600 mb-0.5">过渡建议</div>
                                  <div className="text-xs text-green-700 italic">"{o.transition_hint}"</div>
                                </div>
                              )}
                              {Array.isArray(o.interaction_points) && o.interaction_points.length > 0 && (
                                <div>
                                  <div className="text-xs font-medium text-purple-600 mb-0.5">互动点</div>
                                  <div className="text-xs text-purple-700 truncate">{o.interaction_points[0]}</div>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Suggested Script (Always visible or primary emphasis) */}
                          {o.suggested_script && (
                            <div className="mt-1">
                              <div className="text-xs font-semibold text-neutral-500 mb-1 flex items-center gap-2">
                                <span>建议演讲稿</span>
                              </div>
                              <div className="p-3 bg-gradient-to-br from-white to-neutral-50 rounded-lg border border-neutral-200 text-sm text-neutral-700 leading-relaxed font-sans shadow-sm">
                                {o.suggested_script}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Show more indicator */}
                  {!showAllSlides && pptPrep.outline.length > 4 && (
                    <button
                      onClick={() => setShowAllSlides(true)}
                      className="w-full py-3 text-center text-sm text-primary bg-primary/5 hover:bg-primary/10 rounded-xl transition-colors"
                    >
                      还有 {pptPrep.outline.length - 4} 页，点击展开 ↓
                    </button>
                  )}
                </div>
              ) : (
                <div className="text-sm text-neutral-500">未生成逐页要点</div>
              )}
            </div>
          </div >
        </div >
      </div >
    )
  }

  // Script Analysis Mode
  const isScriptAnalysis = session.mode === 'script_analysis'
  const scriptAnalysis = (report as any)?.script_analysis

  if (isScriptAnalysis && scriptAnalysis) {
    const rawScriptText = String((data as any)?.script_text || '')
    const safeScriptSnippet = (text: string, maxLen = 120) => {
      const t = text.replace(/\s+/g, ' ').trim()
      return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t
    }

    const fallbackScriptInsights = (() => {
      if (!rawScriptText) {
        return { strengths: [] as string[], issues: [] as string[] }
      }

      const paragraphs = rawScriptText
        .split(/\n{2,}/)
        .map(s => s.trim())
        .filter(Boolean)

      const opening = paragraphs[0] || rawScriptText.slice(0, 200)
      const closing = paragraphs.length >= 2 ? paragraphs[paragraphs.length - 1] : rawScriptText.slice(-200)

      const hasQuestion = /[？?]/.test(opening)
      const hasNumber = /\d/.test(rawScriptText)
      const hasCta = /(总结|最后|行动|现在就|接下来|欢迎提问|谢谢)/.test(closing)

      const issues: string[] = []
      if (!hasQuestion) issues.push(`开场缺少“钩子”（提问/反直觉/故事）。开头目前更像陈述：${safeScriptSnippet(opening, 60)}`)
      if (!hasNumber) issues.push('正文证据偏少：建议每个核心论点至少补 1 个数据/案例/类比，避免“正确但不信”。')
      if (!hasCta) issues.push(`结尾缺少明确的“下一步/号召”。结尾目前偏收束式：${safeScriptSnippet(closing, 60)}`)

      const strengths: string[] = []
      if (paragraphs.length >= 3) strengths.push('结构较完整：能分出开头/展开/收束的段落层次。')
      if (/(我们|团队|方案|目标|价值)/.test(rawScriptText)) strengths.push('主题与目标明确：稿件里能读到“要解决什么、带来什么价值”。')


      return { strengths, issues }
    })()

    const totalSec = scriptAnalysis?.estimated_duration_sec
    const totalMin = typeof totalSec === 'number' && totalSec > 0 ? Math.round(totalSec / 60) : null
    const overallScore = scriptAnalysis?.overall_score || 0

    const strengthsToShow = (Array.isArray(scriptAnalysis?.strengths) && scriptAnalysis.strengths.length > 0)
      ? scriptAnalysis.strengths
      : fallbackScriptInsights.strengths

    const issuesToShow = (Array.isArray(scriptAnalysis?.issues) && scriptAnalysis.issues.length > 0)
      ? scriptAnalysis.issues
      : fallbackScriptInsights.issues


    return (
      <div className="min-h-screen bg-neutral-50 py-8">
        <div className="max-w-5xl mx-auto px-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-4">
              <Link to="/history" className="p-2 rounded-xl bg-white shadow-soft hover:shadow-glass">
                <ChevronLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-primary">{session.title || '演讲稿分析报告'}</h1>
                <p className="text-sm text-neutral-500">{new Date(session.created_at).toLocaleString('zh-CN')}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleExportPdf}
                disabled={exportingPdf}
                className="btn-secondary flex items-center gap-2 disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                {exportingPdf ? '导出中...' : '导出 PDF'}
              </button>
              <button
                onClick={handleDelete}
                className="p-3 rounded-xl bg-white shadow-soft hover:bg-red-50 text-neutral-600 hover:text-red-500"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
            {/* Left: Score & Stats */}
            <div className="space-y-4">
              {/* Overall Score */}
              <div className="card text-center">
                <div className="text-6xl font-bold text-primary mb-2">{Math.round(overallScore)}</div>
                <div className="text-neutral-500">综合评分</div>
              </div>

              {/* Sub Scores */}
              <div className="card">
                <h3 className="font-semibold text-primary mb-4">维度评分</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-neutral-600">开场吸引力</span>
                    <span className="font-medium text-primary">{scriptAnalysis?.opening_hook_score || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-neutral-600">逻辑流畅度</span>
                    <span className="font-medium text-primary">{scriptAnalysis?.logic_flow_score || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-neutral-600">情感感染力</span>
                    <span className="font-medium text-primary">{scriptAnalysis?.emotional_appeal_score || 0}</span>
                  </div>
                </div>
              </div>

              {/* Stats */}
              <div className="card">
                <h3 className="font-semibold text-primary mb-4">基本信息</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-neutral-500">字数</span>
                    <span className="text-neutral-700">{scriptAnalysis?.word_count || 0} 字</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-500">预估时长</span>
                    <span className="text-neutral-700">{totalMin ? `${totalMin} 分钟` : '—'}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Details */}
            <div className="col-span-2 space-y-4">
              {/* Script Content */}
              {(data as any)?.script_text && (
                <details className="card group">
                  <summary className="font-semibold text-primary cursor-pointer flex items-center justify-between">
                    <span>演讲稿原文</span>
                    <span className="text-xs text-neutral-400 group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <div className="mt-4 p-4 bg-neutral-50 rounded-xl max-h-64 overflow-y-auto text-sm text-neutral-600 whitespace-pre-wrap leading-relaxed">
                    {(data as any).script_text}
                  </div>
                </details>
              )}

              {/* Structure */}
              <div className="card">
                <h3 className="font-semibold text-primary mb-4">结构分析</h3>
                <div className="flex items-center gap-4 mb-4">
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${scriptAnalysis?.structure?.has_opening ? 'bg-accent-success/10 text-accent-success' : 'bg-neutral-100 text-neutral-500'
                    }`}>
                    {scriptAnalysis?.structure?.has_opening ? '✓ 有开场' : '✗ 缺少开场'}
                  </span>
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${scriptAnalysis?.structure?.has_body ? 'bg-accent-success/10 text-accent-success' : 'bg-neutral-100 text-neutral-500'
                    }`}>
                    {scriptAnalysis?.structure?.has_body ? '✓ 有正文' : '✗ 缺少正文'}
                  </span>
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${scriptAnalysis?.structure?.has_closing ? 'bg-accent-success/10 text-accent-success' : 'bg-neutral-100 text-neutral-500'
                    }`}>
                    {scriptAnalysis?.structure?.has_closing ? '✓ 有结尾' : '✗ 缺少结尾'}
                  </span>
                </div>
                {scriptAnalysis?.structure?.sections?.length > 0 && (
                  <div>
                    <div className="text-xs text-neutral-500 mb-2">识别的段落结构：</div>
                    <div className="flex flex-wrap gap-2">
                      {scriptAnalysis.structure.sections.map((s: string, i: number) => (
                        <span key={i} className="px-2 py-1 bg-neutral-100 rounded text-sm text-neutral-700">{s}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Key Points */}
              {scriptAnalysis?.key_points?.length > 0 && (
                <div className="card">
                  <h3 className="font-semibold text-primary mb-3">核心论点</h3>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-neutral-600">
                    {scriptAnalysis.key_points.map((pt: string, i: number) => (
                      <li key={i}>{pt}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Strengths & Issues */}
              <div className="grid grid-cols-2 gap-4">
                <div className="card">
                  <h3 className="font-semibold text-accent-success mb-3 flex items-center gap-2">
                    <Star className="w-4 h-4" /> 优点
                  </h3>
                  {strengthsToShow.length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1 text-sm text-neutral-600">
                      {strengthsToShow.map((s: string, i: number) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-neutral-500">暂无明显优点提示（可通过“具体修改示例”查看改写方向）</div>
                  )}
                </div>
                <div className="card">
                  <h3 className="font-semibold text-accent-error mb-3 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" /> 待改进
                  </h3>
                  {issuesToShow.length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1 text-sm text-neutral-600">
                      {issuesToShow.map((s: string, i: number) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-neutral-500">未生成待改进条目（建议查看下方“具体修改示例/综合建议”）</div>
                  )}
                </div>
              </div>

              {/* Suggestions */}
              {scriptAnalysis?.suggestions?.length > 0 && (
                <div className="card">
                  <h3 className="font-semibold text-primary mb-4">AI 改进建议</h3>
                  <ul className="space-y-3">
                    {scriptAnalysis.suggestions.map((suggestion: any, i: number) => {
                      const text = typeof suggestion === 'string' ? suggestion : (suggestion?.suggestion || JSON.stringify(suggestion))
                      return (
                        <li key={i} className="flex gap-3 text-sm text-neutral-600">
                          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent-success/10 text-accent-success flex items-center justify-center text-xs font-medium">
                            {i + 1}
                          </span>
                          {text}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-50 py-8">
      <div className="max-w-7xl mx-auto px-6">
        {/* Analysis progress */}
        {session.status !== 'completed' && (
          <div className="card mb-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-semibold text-primary">分析中</div>
                <div className="text-sm text-neutral-500">{stageLabel(analysisProgress?.stage)}</div>
              </div>
              <div className="w-56">
                <div className="h-2 bg-neutral-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.min(100, Math.max(0, analysisProgress?.progress ?? 0))}%` }}
                  />
                </div>
                <div className="text-xs text-neutral-500 mt-2 text-right">
                  {Math.min(100, Math.max(0, analysisProgress?.progress ?? 0))}%
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link
              to="/history"
              className="p-2 rounded-xl bg-white shadow-soft hover:shadow-glass"
            >
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-primary">
                {session.title || '练习回顾'}
              </h1>
              <p className="text-sm text-neutral-500">
                {new Date(session.created_at).toLocaleString('zh-CN')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleExportPdf}
              disabled={exportingPdf}
              className="btn-secondary flex items-center gap-2 disabled:opacity-60"
            >
              <Download className="w-4 h-4" />
              {exportingPdf ? '导出中...' : '导出 PDF'}
            </button>
            <button
              onClick={handleDelete}
              className="p-3 rounded-xl bg-white shadow-soft hover:bg-red-50 text-neutral-600 hover:text-red-500"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Video Player */}
          <div className="col-span-2 space-y-4">
            <div className="card p-0 overflow-hidden">
              <div className="relative">
                <video
                  ref={videoRef}
                  src={localVideoUrl || getVideoUrl(sessionId!)}
                  className="w-full aspect-video bg-black"
                  controls={false}
                  onLoadedMetadata={() => {
                    const v = videoRef.current
                    if (!v) return
                    const ms = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0
                    if (ms > 0) setDurationMs(ms)
                  }}
                />

                {/* Live subtitles (ASR) */}
                {animatedSubtitleText && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[90%] px-4 py-2 rounded-xl bg-black/60 backdrop-blur-sm">
                    <div className="text-white text-sm leading-relaxed line-clamp-2 text-center">
                      {animatedSubtitleText}
                    </div>
                  </div>
                )}

                {/* HUD overlay */}
                <HUD
                  isRecording={!videoRef.current?.paused}
                  speed={currentSpeed}
                  fillerCount={fillerCount}
                  asrText={asrText}
                  elapsedTime={currentTime}
                  totalChars={realtimeTranscriptSegments.reduce((sum, seg) => sum + (seg.text?.length || 0), 0)}
                />
              </div>

              {/* Custom Controls */}
              <div className="p-4 bg-neutral-50 border-t">
                <div className="flex items-center gap-4">
                  <button
                    onClick={handlePlayPause}
                    className="p-2 rounded-lg bg-primary text-white"
                  >
                    {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                  </button>

                  <span className="text-sm text-neutral-500 min-w-[80px]">
                    {formatTime(currentTime)} / {formatTime(safeDurationMs)}
                  </span>

                  {/* Timeline with markers - clickable for seeking */}
                  <div
                    className="flex-1 video-timeline cursor-pointer"
                    onClick={(e) => {
                      if (videoRef.current && safeDurationMs > 0) {
                        const rect = e.currentTarget.getBoundingClientRect()
                        const clickX = e.clientX - rect.left
                        const pct = clickX / rect.width
                        const newTime = pct * safeDurationMs / 1000
                        videoRef.current.currentTime = newTime
                      }
                    }}
                  >
                    {/* Progress bar */}
                    <div
                      className="absolute top-0 left-0 h-full bg-primary/30 pointer-events-none"
                      style={{ width: `${progressPct}%` }}
                    />

                    {/* Playhead line */}
                    <div
                      className="absolute top-0 w-0.5 h-full bg-primary pointer-events-none"
                      style={{ left: `${progressPct}%` }}
                    />

                    {/* Event markers */}
                    {events.map(event => (
                      <div
                        key={event.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleEventClick(event)
                        }}
                        className={`video-timeline-marker ${event.type}`}
                        style={{ left: `${Math.min(100, Math.max(0, (event.start_ms / safeDurationMs) * 100))}%` }}
                        title={event.category}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Transcript */}
            <div className="card">
              <h3 className="font-semibold text-primary mb-4">转录文本</h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {displayTranscriptSegments.length === 0 ? (
                  <div className="text-sm text-neutral-400">
                    {localVideoFile
                      ? (isPlaying
                        ? '语音识别中（首次出字可能需要几秒）'
                        : '播放视频后会自动开始语音转录'
                      )
                      : '暂无转录文本（语音识别未启用或尚未生成）'
                    }
                  </div>
                ) : displayTranscriptSegments.map((segment, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.currentTime = segment.start_ms / 1000
                        videoRef.current.play()
                        setIsPlaying(true)
                      }
                    }}
                    className={`
                      p-2 rounded-lg cursor-pointer transition-colors
                      ${currentTime >= segment.start_ms && currentTime <= segment.end_ms
                        ? 'bg-primary/10'
                        : 'hover:bg-neutral-50'
                      }
                    `}
                  >
                    <span className="text-xs text-neutral-400 mr-2">
                      {formatTime(segment.start_ms)}
                    </span>
                    <span className="text-neutral-700">{segment.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Emotion Curve */}
            {metrics.emotion_curve && metrics.emotion_curve.length > 0 && (
              <div className="card">
                <h3 className="font-semibold text-primary mb-4">情感能量曲线</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={metrics.emotion_curve.map(([time, value]) => ({ time, value }))}>
                    <XAxis
                      dataKey="time"
                      tickFormatter={(v) => formatTime(v)}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                    <Tooltip
                      labelFormatter={(v) => formatTime(v as number)}
                      formatter={(v: number) => [v.toFixed(1), '能量值']}
                    />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#10B981"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Slides Summary (PPT mode) */}
            {(session.mode === 'ppt' || session.mode === 'ppt_analysis') && (
              <div className="card">
                <h3 className="font-semibold text-primary mb-4">分页复盘</h3>
                {slidesSummary.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-neutral-500 border-b">
                          <th className="text-left py-2 pr-3 font-medium">页</th>
                          <th className="text-left py-2 pr-3 font-medium">时长</th>
                          <th className="text-left py-2 pr-3 font-medium">语速</th>
                          <th className="text-left py-2 pr-3 font-medium">口头禅</th>
                          <th className="text-left py-2 pr-3 font-medium">低头</th>
                          <th className="text-left py-2 pr-3 font-medium">视线偏离</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slidesSummary
                          .slice()
                          .sort((a: any, b: any) => (a.slide_index || 0) - (b.slide_index || 0))
                          .map((row: any) => (
                            <tr
                              key={row.slide_index}
                              onClick={() => handleSlideSummaryClick(row.slide_index)}
                              className="border-b last:border-b-0 hover:bg-neutral-50 cursor-pointer"
                              title="点击跳转到该页开始位置"
                            >
                              <td className="py-2 pr-3 text-neutral-700 font-medium">{row.slide_index}</td>
                              <td className="py-2 pr-3 text-neutral-600">{formatTime(row.duration_ms || 0)}</td>
                              <td className="py-2 pr-3 text-neutral-600">{row.speed_cpm || 0} CPM</td>
                              <td className="py-2 pr-3 text-neutral-600">{row.filler_count || 0}</td>
                              <td className="py-2 pr-3 text-neutral-600">{row.head_down_count || 0}</td>
                              <td className="py-2 pr-3 text-neutral-600">{row.look_away_count || 0}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-sm text-neutral-500">
                    本次未生成分页数据。请确保练习过程中有翻页事件（或先完成分析后再查看）。
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sidebar - Scores & Events */}
          <div className="space-y-4">
            {/* Total Score */}
            <div className="card text-center">
              {session.status === 'completed' ? (
                (() => {
                  const dataQuality = (report as any)?.scores?.data_quality
                  const flags: string[] = dataQuality?.flags || []
                  const hasInsufficientData = flags.includes('insufficient_data')
                  const noSpeech = flags.includes('no_speech_transcript')
                  const noAudio = flags.includes('no_audio_features')
                  const noVisual = flags.includes('no_visual_results')

                  // Determine what data is missing
                  const missingItems: string[] = []
                  if (noSpeech) missingItems.push('语音')
                  if (noAudio) missingItems.push('音频')
                  if (noVisual) missingItems.push('视觉')

                  // 更宽松的判断：只有当 insufficient_data 明确标记 且 评分为0 才显示"素材不足"
                  // 有评分但有部分缺失时，显示评分并提示
                  if (hasInsufficientData && scores.total === 0) {
                    return (
                      <>
                        <div className="text-4xl font-bold text-neutral-300 mb-2">—</div>
                        <div className="text-neutral-500">本次素材不足，暂不展示评分</div>
                        <div className="text-xs text-neutral-400 mt-1">
                          {missingItems.length > 0
                            ? `需要补齐：${missingItems.join('、')}数据（建议：视频≥20秒、画面有人脸、确保有清晰声音）`
                            : '建议：录制更长时长、保持正面出镜并确保声音清晰'}
                        </div>
                      </>
                    )
                  }

                  // 有评分但部分数据缺失，仍然显示评分
                  if (scores.total > 0 && missingItems.length > 0) {
                    return (
                      <>
                        <div className="text-5xl font-bold text-primary mb-2">
                          {Math.round(scores.total)}
                        </div>
                        <div className="text-neutral-500">综合评分</div>
                        <div className="text-xs text-amber-500 mt-1 inline-flex items-center justify-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          部分数据未采集（{missingItems.join('、')}），仅供参考
                        </div>
                      </>
                    )
                  }

                  return (
                    <>
                      <div className="text-6xl font-bold text-primary mb-2">
                        {Math.round(scores.total)}
                      </div>
                      <div className="text-neutral-500">综合评分</div>
                    </>
                  )
                })()
              ) : (
                <>
                  <div className="text-4xl font-bold text-neutral-300 mb-2">--</div>
                  <div className="text-neutral-500">AI 分析中，暂无评分</div>
                  <div className="mt-2 flex items-center justify-center gap-2">
                    <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                    <span className="text-xs text-primary">{analysisProgress?.progress || 0}%</span>
                  </div>
                </>
              )}
            </div>

            {/* Radar Chart */}
            <div className="card">
              <h3 className="font-semibold text-primary mb-4">五维评分</h3>
              {session.status === 'completed' ? (
                <ResponsiveContainer width="100%" height={250}>
                  <RadarChart data={radarData}>
                    <PolarGrid />
                    <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                    <Radar
                      dataKey="value"
                      stroke="#0F172A"
                      fill="#0F172A"
                      fillOpacity={0.2}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[250px] flex items-center justify-center">
                  <div className="text-center text-neutral-400">
                    <div className="w-12 h-12 mx-auto mb-3 rounded-full border-2 border-neutral-200 border-t-primary animate-spin" />
                    <div className="text-sm">分析完成后显示评分</div>
                  </div>
                </div>
              )}
            </div>

            {/* Issues */}
            <div className="card">
              <h3 className="font-semibold text-primary mb-4 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-accent-error" />
                问题 ({issues.length})
              </h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {issues.length > 0 ? issues.map(issue => (
                  <motion.div
                    key={issue.id}
                    onClick={() => handleEventClick(issue)}
                    className={`
                      p-3 rounded-xl cursor-pointer transition-all
                      ${selectedEventId === issue.id
                        ? 'bg-accent-error/10 ring-1 ring-accent-error'
                        : 'bg-neutral-50 hover:bg-neutral-100'
                      }
                    `}
                    whileHover={{ scale: 1.02 }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-neutral-700">
                        {getCategoryLabel(issue.category)}
                      </span>
                      <span className="text-xs text-neutral-400">
                        {formatTime(issue.start_ms)}
                      </span>
                    </div>
                    {issue.evidence && (
                      <p className="text-xs text-neutral-500 truncate">
                        {typeof issue.evidence === 'object'
                          ? (issue.evidence as any).asr_text || (issue.evidence as any).description || ''
                          : ''}
                      </p>
                    )}
                  </motion.div>
                )) : (
                  <div className="text-sm text-neutral-500">
                    暂未检测到明显问题事件。想让复盘更“有料”，建议练习时长 ≥ 30 秒，并保持语音清晰与正面出镜。
                  </div>
                )}
              </div>
            </div>

            {/* Highlights */}
            <div className="card">
              <h3 className="font-semibold text-primary mb-4 flex items-center gap-2">
                <Star className="w-4 h-4 text-accent-warning" />
                亮点 ({highlights.length})
              </h3>
              {highlights.length > 0 ? (
                <div className="space-y-2">
                  {highlights.map(highlight => (
                    <div
                      key={highlight.id}
                      onClick={() => handleEventClick(highlight)}
                      className="p-3 rounded-xl bg-accent-warning/10 cursor-pointer hover:bg-accent-warning/20"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-neutral-700">
                          {getCategoryLabel(highlight.category)}
                        </span>
                        <span className="text-xs text-neutral-400">
                          {formatTime(highlight.start_ms)}
                        </span>
                      </div>
                      {highlight.evidence && (
                        <p className="text-xs text-neutral-600 mt-1 line-clamp-2">
                          {typeof highlight.evidence === 'object'
                            ? (highlight.evidence as any).description || (highlight.evidence as any).asr_text || ''
                            : ''}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-neutral-500">
                  暂未自动捕捉到亮点事件。可以尝试：更有情绪起伏的表达、关键句停顿、面向镜头的眼神交流。
                </div>
              )}
            </div>

            {/* Suggestions */}
            {report?.suggestions && report.suggestions.length > 0 && (
              <div className="card">
                <h3 className="font-semibold text-primary mb-4">AI 改进建议</h3>
                <ul className="space-y-3">
                  {report.suggestions.map((suggestion, i) => {
                    // Handle both string and object formats (GLM may return {suggestion: "..."})
                    const text = typeof suggestion === 'string'
                      ? suggestion
                      : (suggestion as any)?.suggestion || JSON.stringify(suggestion)
                    return (
                      <li key={i} className="flex gap-3 text-sm text-neutral-600">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent-success/10 text-accent-success flex items-center justify-center text-xs font-medium">
                          {i + 1}
                        </span>
                        {text}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    filler_word: '口头禅',
    speed_fast: '语速过快',
    speed_slow: '语速过慢',
    head_down: '低头',
    look_away: '视线偏离',
    pause_long: '停顿过长',
    glm_visual: '画面表现',
    posture: '姿态问题',
    body_sway: '身体晃动',
  }
  return labels[category] || category
}
