import { motion } from 'framer-motion'
import { FileText, ChevronUp, ChevronDown, Type } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

interface ScriptTeleprompterProps {
    content: string
    className?: string
}

export default function ScriptTeleprompter({ content, className = '' }: ScriptTeleprompterProps) {
    const [scrollPosition, setScrollPosition] = useState(0)
    const [fontSize, setFontSize] = useState(24) // Default larger font
    const containerRef = useRef<HTMLDivElement>(null)

    // Split content into paragraphs
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim())

    const scrollUp = () => {
        if (containerRef.current) {
            containerRef.current.scrollBy({ top: -150, behavior: 'smooth' })
        }
    }

    const scrollDown = () => {
        if (containerRef.current) {
            containerRef.current.scrollBy({ top: 150, behavior: 'smooth' })
        }
    }

    // Handle keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                scrollUp()
            } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                scrollDown()
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [])

    // Track scroll position
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container
            setScrollPosition(scrollHeight > clientHeight ? (scrollTop / (scrollHeight - clientHeight)) * 100 : 0)
        }

        container.addEventListener('scroll', handleScroll)
        return () => container.removeEventListener('scroll', handleScroll)
    }, [])

    return (
        <div className={`h-full flex flex-col bg-transparent ${className}`}>
            {/* Header / Toolbar */}
            <div className="flex items-center justify-between p-4 border-b border-white/5 bg-black/20 backdrop-blur-sm relative z-10">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-emerald-500/10 rounded-lg text-emerald-400">
                        <FileText className="w-5 h-5" />
                    </div>
                    <div>
                        <span className="block text-sm font-medium text-white/90">演讲稿</span>
                        <span className="block text-xs text-white/40">滚动浏览或使用键盘 ↑↓</span>
                    </div>
                </div>

                {/* Font Size Control */}
                <div className="flex items-center bg-white/5 rounded-lg border border-white/5 p-1">
                    <button
                        onClick={() => setFontSize(Math.max(16, fontSize - 2))}
                        className="p-1.5 text-white/50 hover:text-white hover:bg-white/10 rounded transition-colors"
                    >
                        <Type className="w-3 h-3 scale-75" />
                    </button>
                    <span className="text-xs w-8 text-center text-white/60 font-mono">{fontSize}</span>
                    <button
                        onClick={() => setFontSize(Math.min(48, fontSize + 2))}
                        className="p-1.5 text-white/50 hover:text-white hover:bg-white/10 rounded transition-colors"
                    >
                        <Type className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Progress bar */}
            <div className="w-full h-[2px] bg-white/5">
                <motion.div
                    className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                    initial={{ width: 0 }}
                    animate={{ width: `${scrollPosition}%` }}
                    transition={{ duration: 0.1 }}
                />
            </div>

            {/* Content Area */}
            <div
                ref={containerRef}
                className="flex-1 overflow-y-auto px-12 py-10 space-y-8 scrollbar-hide scroll-smooth"
                style={{ scrollBehavior: 'smooth' }}
            >
                {paragraphs.map((paragraph, index) => (
                    <motion.div
                        key={index}
                        initial={{ opacity: 0.3 }}
                        whileInView={{ opacity: 1 }}
                        exit={{ opacity: 0.3 }}
                        viewport={{ margin: '-15% 0px -15% 0px' }} // Focus center
                        className="text-slate-200 leading-loose transition-colors duration-500"
                        style={{ fontSize: `${fontSize}px`, fontWeight: 300 }}
                    >
                        {paragraph.split('\n').map((line, lineIndex) => (
                            <p key={lineIndex} className="mb-4">
                                {line}
                            </p>
                        ))}
                    </motion.div>
                ))}

                {/* Bottom padding for last paragraph visibility */}
                <div className="h-[50vh]" />
            </div>

            {/* Floating Navigation (Bottom Right) */}
            <div className="absolute bottom-6 right-8 flex flex-col gap-2 opacity-0 hover:opacity-100 transition-opacity duration-300">
                <button
                    onClick={scrollUp}
                    className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white shadow-lg backdrop-blur-sm border border-white/5"
                >
                    <ChevronUp className="w-5 h-5" />
                </button>
                <button
                    onClick={scrollDown}
                    className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white shadow-lg backdrop-blur-sm border border-white/5"
                >
                    <ChevronDown className="w-5 h-5" />
                </button>
            </div>
        </div>
    )
}
