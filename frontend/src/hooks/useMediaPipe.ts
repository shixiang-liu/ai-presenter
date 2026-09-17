/**
 * MediaPipe Hook for Real-time Pose and Face Detection
 * 
 * Uses MediaPipe Tasks Vision API for:
 * - Pose landmarks (33 points)
 * - Face landmarks (478 points) for head pose estimation
 */
import { useRef, useState, useCallback, useEffect } from 'react'
import {
  PoseLandmarker,
  FaceLandmarker,
  FilesetResolver
} from '@mediapipe/tasks-vision'

interface UseMediaPipeOptions {
  delegate?: 'GPU' | 'CPU'
  maxFps?: number
  onPoseUpdate?: (landmarks: any[]) => void
  onHeadPose?: (pitch: number, yaw: number, roll: number) => void
  onFaceBoundingBox?: (box: { x: number; y: number; width: number; height: number } | null) => void
  onCalibrationStatus?: (isCalibrating: boolean, progress: number) => void
}

export default function useMediaPipe(options: UseMediaPipeOptions) {
  const { delegate = 'GPU', maxFps, onPoseUpdate, onHeadPose, onFaceBoundingBox, onCalibrationStatus } = options

  const [isReady, setIsReady] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)

  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null)
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const lastVideoTimeRef = useRef(-1)
  const lastProcessTsRef = useRef<number>(0)
  const lastFaceDetectedRef = useRef<number>(0)  // 记录最后一次检测到人脸的时间
  const lastKnownPoseRef = useRef<{ pitch: number; yaw: number; roll: number } | null>(null) // 记忆最后检测到的姿态

  // Calibration reference (neutral head pose)
  const calibrationRef = useRef<{ pitch: number; yaw: number; roll: number } | null>(null)
  const calibrationCountRef = useRef(0)

  // Initialize MediaPipe
  useEffect(() => {
    async function initMediaPipe() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        )

        // Initialize Pose Landmarker
        poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
            delegate
          },
          runningMode: 'VIDEO',
          numPoses: 1
        })

        // Initialize Face Landmarker with multi-face support to pick the largest face
        faceLandmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate
          },
          runningMode: 'VIDEO',
          numFaces: 5,  // Detect up to 5 faces, then pick the largest
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true
        })

        setIsReady(true)
        console.log('[MediaPipe] 初始化成功 - Pose 和 Face 检测已就绪')
      } catch (err) {
        console.error('[MediaPipe] 初始化失败:', err)
      }
    }

    initMediaPipe()

    return () => {
      if (poseLandmarkerRef.current) {
        poseLandmarkerRef.current.close()
      }
      if (faceLandmarkerRef.current) {
        faceLandmarkerRef.current.close()
      }
    }
  }, [])

  // Detect loop
  const detectFrame = useCallback((video: HTMLVideoElement) => {
    if (!poseLandmarkerRef.current || !faceLandmarkerRef.current) return

    // Protect against invalid video state (fixes crash in video analysis mode)
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      animationFrameRef.current = requestAnimationFrame(() => detectFrame(video))
      return
    }

    if (video.currentTime === lastVideoTimeRef.current) {
      animationFrameRef.current = requestAnimationFrame(() => detectFrame(video))
      return
    }

    lastVideoTimeRef.current = video.currentTime
    const timestamp = performance.now()

    const fps = typeof maxFps === 'number' && Number.isFinite(maxFps) ? maxFps : undefined
    const minIntervalMs = fps && fps > 0 ? (1000 / fps) : 0
    if (minIntervalMs > 0 && (timestamp - lastProcessTsRef.current) < minIntervalMs) {
      animationFrameRef.current = requestAnimationFrame(() => detectFrame(video))
      return
    }
    lastProcessTsRef.current = timestamp

    // Pose detection
    try {
      const poseResults = poseLandmarkerRef.current.detectForVideo(video, timestamp)
      if (poseResults.landmarks && poseResults.landmarks.length > 0) {
        onPoseUpdate?.(poseResults.landmarks[0])
      }
    } catch (err) {
      // Ignore detection errors
    }

    // Face detection for head pose
    try {
      const faceResults = faceLandmarkerRef.current.detectForVideo(video, timestamp)

      // 调试：检测到的人脸数量
      if (Math.random() < 0.01) {
        console.log('[MediaPipe] 检测到人脸数量:', faceResults.faceLandmarks?.length || 0)
      }

      // Find the largest face (by bounding box area) among all detected faces
      if (faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) {
        let largestFaceIndex = 0
        let largestArea = 0

        // Calculate bounding boxes for all faces and find the largest
        const faceBoundingBoxes = faceResults.faceLandmarks.map((landmarks, idx) => {
          let minX = 1, maxX = 0, minY = 1, maxY = 0
          for (const lm of landmarks) {
            minX = Math.min(minX, lm.x)
            maxX = Math.max(maxX, lm.x)
            minY = Math.min(minY, lm.y)
            maxY = Math.max(maxY, lm.y)
          }
          const area = (maxX - minX) * (maxY - minY)
          if (area > largestArea) {
            largestArea = area
            largestFaceIndex = idx
          }
          return { minX, maxX, minY, maxY, area }
        })

        // Use the largest face's bounding box
        const largestBox = faceBoundingBoxes[largestFaceIndex]
        const padding = 0.05
        const minX = Math.max(0, largestBox.minX - padding)
        const minY = Math.max(0, largestBox.minY - padding)
        const maxX = Math.min(1, largestBox.maxX + padding)
        const maxY = Math.min(1, largestBox.maxY + padding)

        lastFaceDetectedRef.current = timestamp  // 更新最后检测到人脸的时间

        onFaceBoundingBox?.({
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY
        })

        // Use the largest face's transformation matrix for head pose
        if (faceResults.facialTransformationMatrixes && faceResults.facialTransformationMatrixes[largestFaceIndex]) {
          const matrix = faceResults.facialTransformationMatrixes[largestFaceIndex].data

          // Extract Euler angles from transformation matrix
          const { pitch, yaw, roll } = extractEulerAngles(matrix)

          // Calibration during first 3 seconds (30 frames at ~10fps)
          const CALIBRATION_FRAMES = 30
          if (calibrationCountRef.current < CALIBRATION_FRAMES) {
            if (!calibrationRef.current) {
              calibrationRef.current = { pitch: 0, yaw: 0, roll: 0 }
            }
            // Running average
            calibrationRef.current.pitch = (calibrationRef.current.pitch * calibrationCountRef.current + pitch) / (calibrationCountRef.current + 1)
            calibrationRef.current.yaw = (calibrationRef.current.yaw * calibrationCountRef.current + yaw) / (calibrationCountRef.current + 1)
            calibrationRef.current.roll = (calibrationRef.current.roll * calibrationCountRef.current + roll) / (calibrationCountRef.current + 1)
            calibrationCountRef.current++

            // Notify calibration progress
            const progress = (calibrationCountRef.current / CALIBRATION_FRAMES) * 100
            onCalibrationStatus?.(true, progress)
          } else {
            // Calibration complete
            // 只在刚完成校准的那一帧打印一次
            if (calibrationCountRef.current === CALIBRATION_FRAMES) {
              const cal = calibrationRef.current || { pitch: 0, yaw: 0, roll: 0 }
              console.log('[MediaPipe] 校准完成，基准姿态:', {
                pitch: cal.pitch.toFixed(1),
                yaw: cal.yaw.toFixed(1),
                roll: cal.roll.toFixed(1)
              })
              
              // 验证校准值合理性（大厂标准：正常人类头部姿态范围）
              const isPitchAbnormal = cal.pitch < -15 || cal.pitch > 15  // 低头/抬头超过15度
              const isYawAbnormal = Math.abs(cal.yaw) > 20  // 左右偏转超过20度
              
              if (isPitchAbnormal || isYawAbnormal) {
                console.warn('[MediaPipe] ⚠️ 校准基准异常！可能校准时姿态不正确', {
                  pitch: cal.pitch.toFixed(1),
                  yaw: cal.yaw.toFixed(1),
                  isPitchAbnormal,
                  isYawAbnormal
                })
                console.warn('[MediaPipe] 💡 建议：重新校准时请保持正视镜头，头部端正')
              } else {
                console.log('[MediaPipe] ✅ 校准基准正常')
              }
              
              calibrationCountRef.current++ // 增加计数器以避免重复打印
            }
            onCalibrationStatus?.(false, 100)

            // Apply calibration offset
            const cal = calibrationRef.current || { pitch: 0, yaw: 0, roll: 0 }
            const calibratedPitch = pitch - cal.pitch
            const calibratedYaw = yaw - cal.yaw
            const calibratedRoll = roll - cal.roll

            // 调试：每50帧打印一次头部姿态数据
            if (Math.random() < 0.02) {
              console.log('[MediaPipe] 头部姿态:', {
                pitch: calibratedPitch.toFixed(1),
                yaw: calibratedYaw.toFixed(1),
                roll: calibratedRoll.toFixed(1)
              })
              console.log('[MediaPipe] onHeadPose 回调存在:', !!onHeadPose)
            }

            // 保存最后已知的姿态
            lastKnownPoseRef.current = { pitch: calibratedPitch, yaw: calibratedYaw, roll: calibratedRoll }
            
            onHeadPose?.(calibratedPitch, calibratedYaw, calibratedRoll)
          }
        }
      } else {
        // 人脸丢失 - 只在超过2秒未检测到人脸时才清除框
        const timeSinceLastDetection = timestamp - lastFaceDetectedRef.current
        if (timeSinceLastDetection > 2000) {
          if (Math.random() < 0.05) {
            console.log('[MediaPipe] 人脸丢失超过2秒，清除识别框')
          }
          onFaceBoundingBox?.(null)
          lastKnownPoseRef.current = null // 清除记忆的姿态
        } else {
          // 人脸暂时丢失（可能是低头），保持框的显示并继续使用最后已知姿态
          if (Math.random() < 0.1) {
            console.log('[MediaPipe] 人脸暂时丢失，保持识别框并使用最后姿态')
          }
          
          // 重要：即使人脸丢失，也继续调用 onHeadPose，使用最后已知的姿态
          // 这样低头/视线偏离的持续时间可以继续累积
          if (lastKnownPoseRef.current && onHeadPose) {
            onHeadPose(lastKnownPoseRef.current.pitch, lastKnownPoseRef.current.yaw, lastKnownPoseRef.current.roll)
          }
        }
      }
    } catch (err) {
      // Ignore detection errors
    }

    animationFrameRef.current = requestAnimationFrame(() => detectFrame(video))
  }, [maxFps, onPoseUpdate, onHeadPose, onFaceBoundingBox, onCalibrationStatus])

  const startDetection = useCallback((video: HTMLVideoElement) => {
    if (!isReady || isDetecting) return

    // Reset calibration
    calibrationRef.current = null
    calibrationCountRef.current = 0

    console.log('[MediaPipe] 开始检测 - 将进行3秒头部姿态校准')
    setIsDetecting(true)
    detectFrame(video)
  }, [isReady, isDetecting, detectFrame])

  const stopDetection = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    setIsDetecting(false)
  }, [])

  // 重新校准：重置校准计数器，下次检测时会重新进行3秒校准
  const recalibrate = useCallback(() => {
    console.log('[MediaPipe] 🔄 手动重新校准')
    calibrationRef.current = null
    calibrationCountRef.current = 0
    // 通知上层开始校准
    onCalibrationStatus?.(true, 0)
  }, [onCalibrationStatus])

  return {
    isReady,
    isDetecting,
    startDetection,
    stopDetection,
    recalibrate  // 导出重新校准函数
  }
}

/**
 * Extract Euler angles (pitch, yaw, roll) from 4x4 transformation matrix
 */
function extractEulerAngles(matrix: number[] | Float32Array): { pitch: number; yaw: number; roll: number } {
  // Matrix is column-major, 4x4
  // Rotation matrix is in the upper-left 3x3
  const m00 = matrix[0], m01 = matrix[4]
  const m10 = matrix[1], m11 = matrix[5]
  const m20 = matrix[2], m21 = matrix[6], m22 = matrix[10]

  // Extract Euler angles (ZYX convention)
  let pitch: number, yaw: number, roll: number

  if (Math.abs(m20) < 0.9999) {
    pitch = Math.asin(-m20)
    yaw = Math.atan2(m10, m00)
    roll = Math.atan2(m21, m22)
  } else {
    // Gimbal lock
    pitch = m20 < 0 ? Math.PI / 2 : -Math.PI / 2
    yaw = Math.atan2(-m01, m11)
    roll = 0
  }

  // Convert to degrees
  const toDeg = 180 / Math.PI
  return {
    pitch: pitch * toDeg,
    yaw: yaw * toDeg,
    roll: roll * toDeg
  }
}
