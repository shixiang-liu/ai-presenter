/**
 * CameraPiP (Picture-in-Picture) Component
 * Floating draggable camera preview with face bounding box
 */
import { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { motion } from 'framer-motion'
import { Maximize2, Minimize2, Move } from 'lucide-react'

interface CameraPiPProps {
  stream?: MediaStream | null
  faceBoundingBox?: { x: number; y: number; width: number; height: number } | null
  isRecording?: boolean
}

export interface CameraPiPRef {
  videoElement: HTMLVideoElement | null
}

const CameraPiP = forwardRef<CameraPiPRef, CameraPiPProps>(({ stream, faceBoundingBox, isRecording }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  
  // 暴露video元素给父组件
  useImperativeHandle(ref, () => ({
    videoElement: videoRef.current
  }), [])
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium')
  const [position, setPosition] = useState({ x: 0, y: 0 })
  
  // Size presets
  const sizes = {
    small: { width: 200, height: 150 },
    medium: { width: 320, height: 240 },
    large: { width: 480, height: 360 },
  }
  
  const currentSize = sizes[size]
  
  // Bind stream to video element
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
    }
  }, [stream])
  
  // Load saved position
  useEffect(() => {
    const saved = localStorage.getItem('camera_pip_position')
    if (saved) {
      try {
        setPosition(JSON.parse(saved))
      } catch {}
    }
    const savedSize = localStorage.getItem('camera_pip_size')
    if (savedSize && (savedSize === 'small' || savedSize === 'medium' || savedSize === 'large')) {
      setSize(savedSize)
    }
  }, [])
  
  // Save position on drag end
  const handleDragEnd = (_: any, info: { point: { x: number; y: number } }) => {
    const newPos = { 
      x: info.point.x - window.innerWidth + currentSize.width + 24, 
      y: info.point.y - window.innerHeight + currentSize.height + 24 
    }
    setPosition(newPos)
    localStorage.setItem('camera_pip_position', JSON.stringify(newPos))
  }
  
  const cycleSize = () => {
    const nextSize = size === 'small' ? 'medium' : size === 'medium' ? 'large' : 'small'
    setSize(nextSize)
    localStorage.setItem('camera_pip_size', nextSize)
  }
  
  return (
    <motion.div
      ref={containerRef}
      drag
      dragMomentum={false}
      dragElastic={0.1}
      onDragEnd={handleDragEnd}
      initial={{ x: position.x, y: position.y }}
      animate={{ width: currentSize.width, height: currentSize.height }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="fixed bottom-6 right-6 z-40 cursor-move rounded-2xl overflow-hidden shadow-2xl border-2 border-white/20"
      style={{ aspectRatio: '4/3' }}
    >
      {/* Video container */}
      <div className="relative w-full h-full bg-black">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover mirror"
          style={{ transform: 'scaleX(-1)' }}
        />
        
        {/* Face bounding box overlay */}
        {faceBoundingBox && (
          <svg 
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
          >
            {/* Mirrored bounding box (because video is mirrored) */}
            <rect
              x={1 - faceBoundingBox.x - faceBoundingBox.width}
              y={faceBoundingBox.y}
              width={faceBoundingBox.width}
              height={faceBoundingBox.height}
              fill="none"
              stroke="#10B981"
              strokeWidth="0.005"
              rx="0.02"
              ry="0.02"
              className="animate-pulse"
            />
            {/* Corner accents */}
            <g stroke="#10B981" strokeWidth="0.008" fill="none">
              {/* Top-left */}
              <path d={`M ${1 - faceBoundingBox.x - faceBoundingBox.width + 0.02} ${faceBoundingBox.y} 
                        L ${1 - faceBoundingBox.x - faceBoundingBox.width} ${faceBoundingBox.y} 
                        L ${1 - faceBoundingBox.x - faceBoundingBox.width} ${faceBoundingBox.y + 0.03}`} />
              {/* Top-right */}
              <path d={`M ${1 - faceBoundingBox.x - 0.02} ${faceBoundingBox.y} 
                        L ${1 - faceBoundingBox.x} ${faceBoundingBox.y} 
                        L ${1 - faceBoundingBox.x} ${faceBoundingBox.y + 0.03}`} />
              {/* Bottom-left */}
              <path d={`M ${1 - faceBoundingBox.x - faceBoundingBox.width} ${faceBoundingBox.y + faceBoundingBox.height - 0.03} 
                        L ${1 - faceBoundingBox.x - faceBoundingBox.width} ${faceBoundingBox.y + faceBoundingBox.height} 
                        L ${1 - faceBoundingBox.x - faceBoundingBox.width + 0.02} ${faceBoundingBox.y + faceBoundingBox.height}`} />
              {/* Bottom-right */}
              <path d={`M ${1 - faceBoundingBox.x} ${faceBoundingBox.y + faceBoundingBox.height - 0.03} 
                        L ${1 - faceBoundingBox.x} ${faceBoundingBox.y + faceBoundingBox.height} 
                        L ${1 - faceBoundingBox.x - 0.02} ${faceBoundingBox.y + faceBoundingBox.height}`} />
            </g>
          </svg>
        )}
        
        {/* Recording indicator */}
        {isRecording && (
          <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/50 backdrop-blur-sm">
            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            <span className="text-xs text-white font-medium">REC</span>
          </div>
        )}
        
        {/* Controls */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          <button
            onClick={cycleSize}
            className="p-1.5 rounded-lg bg-black/50 backdrop-blur-sm text-white/80 hover:text-white hover:bg-black/70 transition-colors"
            title="调整大小"
          >
            {size === 'small' ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
        
        {/* Drag indicator */}
        <div className="absolute top-2 right-2 p-1 rounded bg-black/30 backdrop-blur-sm">
          <Move className="w-3 h-3 text-white/50" />
        </div>
      </div>
    </motion.div>
  )
})

CameraPiP.displayName = 'CameraPiP'

export default CameraPiP
