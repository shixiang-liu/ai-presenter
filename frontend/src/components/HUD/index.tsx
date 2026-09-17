/**
 * HUD (Head-Up Display) Component
 * Real-time feedback overlay during practice
 * 
 * Design: Glassmorphism + Draggable + Minimal icons
 */
import { useRef, useState, useEffect, useMemo } from 'react'
import { motion, useDragControls } from 'framer-motion'
import {
  Gauge, MessageSquare,
  AlertTriangle, CheckCircle, Type, Clock, Eye, ArrowDown
} from 'lucide-react'
import useTypewriterText from '../../hooks/useTypewriterText'

interface HUDProps {
  isRecording: boolean
  speed: number        // chars per minute (current segment)
  fillerCount: number
  asrText: string      // current interim ASR text
  elapsedTime: number  // ms
  totalChars?: number  // total characters spoken (optional)
  headStatus?: 'normal' | 'head_down' | 'look_away' | null  // Real-time head tracking status
  headDownCount?: number  // Total head-down events
  lookAwayCount?: number  // Total look-away events
}

export default function HUD({
  isRecording,
  speed,
  fillerCount,
  asrText,
  elapsedTime,
  totalChars = 0,
  headStatus = null,
  headDownCount = 0,
  lookAwayCount = 0
}: HUDProps) {
  const dragControls = useDragControls()
  const hudRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const animatedAsrText = useTypewriterText(asrText)

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

  const getDefaultPos = () => {
    const PADDING = 16
    const DEFAULT_BOTTOM = 24
    const DEFAULT_WIDTH = 300
    const DEFAULT_HEIGHT = 220
    // 默认放在右下角，避免遮挡主体画面
    const left = Math.max(PADDING, window.innerWidth - DEFAULT_WIDTH - PADDING)
    const top = window.innerHeight - DEFAULT_HEIGHT - DEFAULT_BOTTOM
    return clampToViewport(left, top)
  }

  const clampToViewport = (left: number, top: number) => {
    const PADDING = 12
    const rect = hudRef.current?.getBoundingClientRect()
    const w = rect?.width || 300
    const h = rect?.height || 220
    const maxLeft = Math.max(PADDING, window.innerWidth - w - PADDING)
    const maxTop = Math.max(PADDING, window.innerHeight - h - PADDING)
    return { left: clamp(left, PADDING, maxLeft), top: clamp(top, PADDING, maxTop) }
  }

  // Load saved position (v2)
  useEffect(() => {
    const saved = localStorage.getItem('hud_position_v2')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (typeof parsed?.left === 'number' && typeof parsed?.top === 'number') {
          setPos(clampToViewport(parsed.left, parsed.top))
          return
        }
      } catch {
        // ignore
      }
    }
    setPos(getDefaultPos())
  }, [])

  // Keep position valid on resize
  useEffect(() => {
    const onResize = () => {
      setPos((prev) => {
        if (!prev) return prev
        const next = clampToViewport(prev.left, prev.top)
        localStorage.setItem('hud_position_v2', JSON.stringify(next))
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Save position on drag end - use element's actual position instead of mouse pointer
  const handleDragEnd = () => {
    if (!hudRef.current) return
    const rect = hudRef.current.getBoundingClientRect()
    const next = clampToViewport(rect.left, rect.top)
    setPos(next)
    localStorage.setItem('hud_position_v2', JSON.stringify(next))
  }

  // Calculate average speed based on total chars and elapsed time
  // 改进：降低门槛到3秒和5个字，更快显示语速，增加更新频率
  const avgSpeed = useMemo(() => {
    if (elapsedTime < 3000 || totalChars < 5) return 0 // 进一步降低门槛
    const minutes = elapsedTime / 1000 / 60
    const calculated = Math.round(totalChars / minutes)
    // 放宽合理范围：60-400
    if (calculated < 60 || calculated > 400) return 0
    return calculated
  }, [totalChars, elapsedTime])

  // Speed status - 使用平均语速作为主要判断依据更稳定
  const getSpeedStatus = (): { status: 'normal' | 'warning' | 'slow' | 'fast', color: string, label: string } => {
    // 优先使用平均语速，因为更稳定可靠
    const displaySpeed = avgSpeed > 0 ? avgSpeed : speed

    if (displaySpeed === 0) return { status: 'normal', color: 'text-white/60', label: '计算中' }
    // 放宽语速范围，减少误报
    if (displaySpeed < 140) return { status: 'slow', color: 'text-blue-400', label: '语速偏慢' }
    if (displaySpeed > 260) return { status: 'fast', color: 'text-orange-400', label: '语速偏快' }
    return { status: 'normal', color: 'text-emerald-400', label: '语速正常' }
  }

  const speedStatus = getSpeedStatus()

  // 强制每秒重新计算一次，确保实时更新（即使totalChars没变化）
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    if (!isRecording) return
    const interval = setInterval(() => {
      forceUpdate(prev => prev + 1)
    }, 1000) // 每秒触发一次重新渲染
    return () => clearInterval(interval)
  }, [isRecording])

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  // Important: keep hooks unconditional across renders
  if (!isRecording) return null

  if (!pos) return null

  return (
    <motion.div
      drag
      dragControls={dragControls}
      dragMomentum={false}
      dragElastic={0.1}
      onDragEnd={handleDragEnd}
      className="fixed z-50 cursor-move"
      style={{ left: pos.left, top: pos.top }}
    >
      <div ref={hudRef} className="glass-dark rounded-2xl p-4 w-[300px] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-white/80">
              {formatTime(elapsedTime)}
            </span>
          </div>
          <div className="text-xs text-white/50">拖拽移动</div>
        </div>

        {/* Metrics Grid - 2x3 */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          {/* Current Speed - 优先显示平均语速 */}
          <MetricCard
            icon={<Gauge className="w-4 h-4" />}
            label="实时语速"
            value={avgSpeed > 0 ? `${avgSpeed}` : (speed > 0 ? `${speed}` : '--')}
            unit="字/分"
            status={speedStatus.status}
            statusColor={speedStatus.color}
          />

          {/* Filler Words - 添加闪烁效果提醒 */}
          <MetricCard
            icon={<MessageSquare className="w-4 h-4" />}
            label="口头禅"
            value={`${fillerCount}`}
            unit="次"
            status={fillerCount > 5 ? 'warning' : 'normal'}
            statusColor={fillerCount > 5 ? 'text-orange-400' : fillerCount > 2 ? 'text-yellow-400' : 'text-emerald-400'}
            highlight={fillerCount > 0 && fillerCount % 3 === 0}
          />

          {/* Total Chars */}
          <MetricCard
            icon={<Type className="w-4 h-4" />}
            label="总字数"
            value={`${totalChars}`}
            unit="字"
            status="normal"
            statusColor="text-white/80"
          />

          {/* Elapsed Time */}
          <MetricCard
            icon={<Clock className="w-4 h-4" />}
            label="累积时长"
            value={formatTime(elapsedTime).split(':')[0]}
            unit="分钟"
            status="normal"
            statusColor="text-white/80"
          />
        </div>

        {/* Head/Eye Status Row - 始终显示计数 */}
        <div className="flex items-center gap-2 mb-3 px-1">
          {/* Current Head Status Indicator */}
          {headStatus && headStatus !== 'normal' && (
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium animate-pulse ${headStatus === 'head_down' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'
              }`}>
              <AlertTriangle className="w-3 h-3" />
              {headStatus === 'head_down' ? '注意抬头' : '注意眼神'}
            </div>
          )}

          {/* Counters - 始终显示 */}
          <div className="flex items-center gap-3 text-xs text-white/50">
            <span title="低头次数" className={`inline-flex items-center gap-1 ${headDownCount > 0 ? 'text-amber-400' : ''}`}>
              <ArrowDown className="w-3 h-3" />
              低头 {headDownCount}
            </span>
            <span title="视线偏离次数" className={`inline-flex items-center gap-1 ${lookAwayCount > 0 ? 'text-red-400' : ''}`}>
              <Eye className="w-3 h-3" />
              视线 {lookAwayCount}
            </span>
          </div>
        </div>

        {/* Live ASR Text */}
        {animatedAsrText && (
          <div className="bg-white/5 rounded-xl p-3">
            <p className="text-sm text-white/70 line-clamp-2">
              {animatedAsrText}
            </p>
          </div>
        )}

        {/* Status Indicator */}
        <div className="mt-4 flex items-center justify-center gap-2">
          {fillerCount > 10 || speed > 260 ? (
            <>
              <AlertTriangle className="w-4 h-4 text-amber-400 animate-pulse" />
              <span className="text-xs text-amber-400">注意调整</span>
            </>
          ) : (
            <>
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-xs text-emerald-400">表现良好</span>
            </>
          )}
        </div>
      </div>
    </motion.div>
  )
}

interface MetricCardProps {
  icon: React.ReactNode
  label: string
  value: string
  unit: string
  status: 'normal' | 'warning' | 'slow' | 'fast'
  statusColor: string
  highlight?: boolean
}

function MetricCard({ icon, label, value, unit, statusColor, highlight }: MetricCardProps) {
  return (
    <div className={`bg-white/5 rounded-xl p-3 transition-all duration-300 ${highlight ? 'ring-2 ring-orange-400/50 animate-pulse' : ''}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-white/50">{icon}</span>
        <span className="text-xs text-white/50">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-xl font-semibold ${statusColor}`}>
          {value}
        </span>
        <span className="text-xs text-white/40">{unit}</span>
      </div>
    </div>
  )
}
