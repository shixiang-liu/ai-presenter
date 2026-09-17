/**
 * Smart Teleprompter Component
 * 
 * Supports two display modes:
 * 1. Paginated mode (default): Shows AI-generated scripts per slide with cards
 * 2. Continuous mode: Shows user-uploaded script as continuous text (free scrolling)
 * 
 * Design: Premium Glassmorphism
 */
import { useRef, useState, useMemo, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { List, AlignJustify, Sparkles, Clock, Hash } from 'lucide-react'
import type { Slide } from '../../services/api'

interface TeleprompterProps {
  slides: Slide[]
  currentIndex: number
  /**
   * Prefer continuous scrolling teleprompter.
   * Intended for user-uploaded transcript in PPT mode.
   */
  preferContinuous?: boolean
}

export default function Teleprompter({ slides, currentIndex, preferContinuous }: TeleprompterProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const [displayMode, setDisplayMode] = useState<'paginated' | 'continuous'>(
    preferContinuous ? 'continuous' : 'paginated'
  )

  // Auto-scroll to active card (only in paginated mode)
  useEffect(() => {
    if (displayMode !== 'paginated') return
    const root = containerRef.current
    if (!root) return
    const activeEl = root.querySelector('.active-card')
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentIndex, displayMode])

  const hasAnyUserScript = useMemo(() => {
    return slides.some(s => (s.generated_script || '').trim().length > 0)
  }, [slides])

  useEffect(() => {
    if (preferContinuous && hasAnyUserScript) {
      setDisplayMode('continuous')
    }
  }, [preferContinuous, hasAnyUserScript])

  const mergedScript = useMemo(() => {
    if (displayMode !== 'continuous') return ''
    return slides.map(s =>
      s.generated_script || s.analysis?.suggested_script || s.notes || ''
    ).filter(Boolean).join('\n\n')
  }, [slides, displayMode])

  return (
    <div className="h-full flex flex-col bg-transparent">
      {/* Sidebar Header */}
      <div className="flex-shrink-0 px-6 py-5 border-b border-white/5 bg-black/20 backdrop-blur-md">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white/90 tracking-wide uppercase">
              AI Teleprompter
            </h3>
          </div>
          <div className="text-xs font-mono text-white/40">
            {params(currentIndex + 1)} / {params(slides.length)}
          </div>
        </div>

        {/* Mode Toggle Switch */}
        <div className="bg-white/5 p-1 rounded-lg flex">
          <button
            onClick={() => setDisplayMode('paginated')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-xs font-medium transition-all ${displayMode === 'paginated'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-white/40 hover:text-white/60'
              }`}
          >
            <List className="w-3.5 h-3.5" />
            卡片模式
          </button>
          <button
            onClick={() => setDisplayMode('continuous')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-xs font-medium transition-all ${displayMode === 'continuous'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-white/40 hover:text-white/60'
              }`}
          >
            <AlignJustify className="w-3.5 h-3.5" />
            全文模式
          </button>
        </div>
      </div>

      {/* Content Scroll Area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10 hover:scrollbar-thumb-white/20"
      >
        {/* Continuous mode */}
        {displayMode === 'continuous' && (
          <div className="bg-white/5 border border-white/5 rounded-2xl p-6 shadow-lg">
            <div className="text-base leading-relaxed text-slate-300 font-light whitespace-pre-wrap">
              {mergedScript || (
                <span className="text-white/20 italic text-sm">
                  暂无演讲稿内容...
                </span>
              )}
            </div>
          </div>
        )}

        {/* Paginated mode */}
        {displayMode === 'paginated' && (
          <div className="space-y-6 relative">
            {/* Timeline Line (Visual Only) */}
            <div className="absolute left-4 top-4 bottom-4 w-px bg-white/5 -z-10" />

            <AnimatePresence mode="popLayout">
              {slides.map((slide, index) => {
                const isActive = index === currentIndex
                const isPast = index < currentIndex

                return (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{
                      opacity: isActive ? 1 : isPast ? 0.4 : 0.4,
                      scale: isActive ? 1 : 0.98,
                      filter: isActive ? 'blur(0px)' : 'blur(1px)',
                    }}
                    transition={{ duration: 0.4 }}
                    className={`
                      ${isActive ? 'active-card' : ''} relative group
                      rounded-2xl border transition-all duration-500
                      ${isActive
                        ? 'bg-white/10 border-emerald-500/30 shadow-[0_8px_32px_rgba(0,0,0,0.3)]'
                        : 'bg-white/5 border-transparent hover:bg-white/5'
                      }
                    `}
                  >
                    {/* Active Indicator Dot */}
                    <div className={`
                        absolute -left-[29px] top-6 w-3 h-3 rounded-full border-2 
                        transition-colors duration-300
                        ${isActive ? 'bg-emerald-500 border-black' : 'bg-slate-800 border-slate-600'}
                    `} />

                    <div className="p-5">
                      {/* Header */}
                      <div className="flex items-start gap-3 mb-4 border-b border-white/5 pb-3">
                        <div className={`
                                flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center font-mono text-sm
                                ${isActive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/20'}
                            `}>
                          <Hash className="w-4 h-4" />
                          {index + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          {slide.analysis?.title ? (
                            <h4 className={`text-sm font-medium truncate ${isActive ? 'text-white' : 'text-white/50'}`}>
                              {slide.analysis.title}
                            </h4>
                          ) : (
                            <h4 className="text-sm font-medium text-white/30 italic">Slide {index + 1}</h4>
                          )}
                          {slide.analysis?.estimated_duration_sec && (
                            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-white/30 uppercase tracking-wider">
                              <Clock className="w-3 h-3" />
                              {Math.round(slide.analysis.estimated_duration_sec)} sec
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Analysis / Points */}
                      {slide.analysis?.key_points && slide.analysis.key_points.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-4">
                          {slide.analysis.key_points.slice(0, 3).map((point, i) => (
                            <span key={i} className="px-2 py-0.5 rounded text-[10px] bg-white/5 text-white/60 border border-white/5">
                              {point}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Script Content */}
                      <div className={`
                            text-sm leading-relaxed font-light
                            ${isActive ? 'text-slate-200' : 'text-slate-500 line-clamp-3'}
                        `}>
                        {slide.generated_script || slide.analysis?.suggested_script || slide.notes || (
                          <span className="text-white/20 italic">No script...</span>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Bottom Hint */}
      <div className="p-4 text-center border-t border-white/5 bg-black/20">
        <span className="text-[10px] text-white/30 uppercase tracking-wider">
          Use ← → Keys to Navigate
        </span>
      </div>
    </div>
  )
}

function params(n: number) {
  return String(n).padStart(2, '0')
}
