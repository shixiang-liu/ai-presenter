/**
 * VideoPlayer Component
 * Reusable video player with custom controls, seekable timeline, and event markers
 */
import { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { Play, Pause } from 'lucide-react'
import type { Event } from '../../services/api'

interface VideoPlayerProps {
    src: string
    events?: Event[]
    onTimeUpdate?: (timeMs: number) => void
    onEventClick?: (event: Event) => void
    onPlayStateChange?: (isPlaying: boolean) => void
    subtitleText?: string
    className?: string
}

export interface VideoPlayerRef {
    seekTo: (timeMs: number) => void
    play: () => void
    pause: () => void
    getCurrentTime: () => number
}

function formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
}

const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(({
    src,
    events = [],
    onTimeUpdate,
    onEventClick,
    onPlayStateChange,
    subtitleText,
    className = ''
}, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null)
    const [isPlaying, setIsPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)

    useImperativeHandle(ref, () => ({
        seekTo: (timeMs: number) => {
            if (videoRef.current) {
                videoRef.current.currentTime = timeMs / 1000
            }
        },
        play: () => {
            videoRef.current?.play()
        },
        pause: () => {
            videoRef.current?.pause()
        },
        getCurrentTime: () => {
            return (videoRef.current?.currentTime || 0) * 1000
        }
    }))

    useEffect(() => {
        const video = videoRef.current
        if (!video) return

        const handleTimeUpdate = () => {
            const timeMs = video.currentTime * 1000
            setCurrentTime(timeMs)
            onTimeUpdate?.(timeMs)
        }

        const handleLoadedMetadata = () => {
            setDuration(video.duration * 1000)
        }

        const handlePlay = () => {
            setIsPlaying(true)
            onPlayStateChange?.(true)
        }

        const handlePause = () => {
            setIsPlaying(false)
            onPlayStateChange?.(false)
        }

        video.addEventListener('timeupdate', handleTimeUpdate)
        video.addEventListener('loadedmetadata', handleLoadedMetadata)
        video.addEventListener('play', handlePlay)
        video.addEventListener('pause', handlePause)

        return () => {
            video.removeEventListener('timeupdate', handleTimeUpdate)
            video.removeEventListener('loadedmetadata', handleLoadedMetadata)
            video.removeEventListener('play', handlePlay)
            video.removeEventListener('pause', handlePause)
        }
    }, [onTimeUpdate, onPlayStateChange])

    const handlePlayPause = () => {
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause()
            } else {
                videoRef.current.play()
            }
        }
    }

    const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (videoRef.current && duration > 0) {
            const rect = e.currentTarget.getBoundingClientRect()
            const clickX = e.clientX - rect.left
            const pct = clickX / rect.width
            videoRef.current.currentTime = (pct * duration) / 1000
        }
    }

    const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

    return (
        <div className={`rounded-2xl overflow-hidden bg-white shadow-soft ${className}`}>
            <div className="relative">
                <video
                    ref={videoRef}
                    src={src}
                    className="w-full aspect-video bg-black"
                    controls={false}
                />

                {/* Subtitles */}
                {subtitleText && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[90%] px-4 py-2 rounded-xl bg-black/60 backdrop-blur-sm">
                        <div className="text-white text-sm leading-relaxed line-clamp-2 text-center">
                            {subtitleText}
                        </div>
                    </div>
                )}
            </div>

            {/* Controls */}
            <div className="p-4 bg-neutral-50 border-t">
                <div className="flex items-center gap-4">
                    <button
                        onClick={handlePlayPause}
                        className="p-2 rounded-lg bg-primary text-white hover:bg-primary-light transition-colors"
                    >
                        {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    </button>

                    <span className="text-sm text-neutral-500 min-w-[80px]">
                        {formatTime(currentTime)} / {formatTime(duration)}
                    </span>

                    {/* Timeline */}
                    <div
                        className="flex-1 video-timeline cursor-pointer"
                        onClick={handleTimelineClick}
                    >
                        {/* Progress */}
                        <div
                            className="absolute top-0 left-0 h-full bg-primary/30 pointer-events-none"
                            style={{ width: `${progressPct}%` }}
                        />

                        {/* Playhead */}
                        <div
                            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full shadow-md pointer-events-none"
                            style={{ left: `calc(${progressPct}% - 6px)` }}
                        />

                        {/* Event markers */}
                        {events.map(event => (
                            <div
                                key={event.id}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onEventClick?.(event)
                                }}
                                className={`video-timeline-marker ${event.type}`}
                                style={{ left: `${Math.min(100, Math.max(0, (event.start_ms / duration) * 100))}%` }}
                                title={event.category}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
})

VideoPlayer.displayName = 'VideoPlayer'

export default VideoPlayer
