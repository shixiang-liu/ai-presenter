import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, Presentation, FileText, Mic, Video, ArrowRight, Sparkles, Play } from 'lucide-react'
import { motion } from 'framer-motion'
import { createSession, uploadScript, uploadPptScript } from '../../services/api'

type Mode = 'ppt' | 'ppt_analysis' | 'script' | 'script_analysis' | 'free' | 'upload'

// 演讲练习模式（需要录制）
const practiceModes = [
  {
    id: 'ppt' as Mode,
    title: 'PPT 演示模式',
    description: '上传 PPT 课件，AI 自动生成演讲稿，配合智能提词器练习',
    icon: Presentation,
    recommended: true,
  },
  {
    id: 'script' as Mode,
    title: '演讲稿模式',
    description: '上传 Word/TXT 演讲稿，配合提词器进行演讲练习',
    icon: FileText,
  },
  {
    id: 'free' as Mode,
    title: '自由演讲模式',
    description: '无需课件/稿件也能练：实时语速与镜头表现反馈，适合自我介绍、即兴演讲',
    icon: Mic,
  },
]

// 文件分析模式（仅分析，不录制）
const analysisModes = [
  {
    id: 'ppt_analysis' as Mode,
    title: 'PPT 分析模式',
    description: '只分析 PPT 结构与内容，生成备稿建议（不录制）',
    icon: Presentation,
  },
  {
    id: 'script_analysis' as Mode,
    title: '演讲稿分析模式',
    description: '只分析演讲稿结构与内容，生成改进建议（不录制）',
    icon: FileText,
  },
  {
    id: 'upload' as Mode,
    title: '视频分析模式',
    description: '上传已录制的演讲视频，AI 进行全面分析并生成报告',
    icon: Video,
  },
]

export default function HomePage() {
  const navigate = useNavigate()
  const [selectedMode, setSelectedMode] = useState<Mode>('ppt')
  const [isCreating, setIsCreating] = useState(false)
  const [pptFile, setPptFile] = useState<File | null>(null)
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [scriptFile, setScriptFile] = useState<File | null>(null)
  const [pptScriptFile, setPptScriptFile] = useState<File | null>(null)
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const scriptInputRef = useRef<HTMLInputElement>(null)
  const pptScriptInputRef = useRef<HTMLInputElement>(null)

  const [recentSessions, setRecentSessions] = useState<any[]>([])

  // Load recent sessions
  useEffect(() => {
    fetch('/api/sessions?limit=3')
      .then(res => res.json())
      .then(data => {
        if (data.sessions) {
          setRecentSessions(data.sessions)
        }
      })
      .catch(err => console.error('Failed to load sessions:', err))
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setPptFile(file)
    }
  }, [])

  const handleVideoSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Check video duration for user guidance
    const tempVideo = document.createElement('video')
    tempVideo.preload = 'metadata'
    tempVideo.onloadedmetadata = () => {
      const durationSec = tempVideo.duration
      URL.revokeObjectURL(tempVideo.src)

      if (durationSec > 1800) { // 30 minutes
        alert(`⚠️ 视频时长约 ${Math.round(durationSec / 60)} 分钟，较长。分析可能需要较长时间（约 3-5 分钟）。建议：单次分析不超过 20 分钟，超长视频可分段上传。`)
      } else if (durationSec > 600) { // 10 minutes
        alert(`ℹ️ 视频时长约 ${Math.round(durationSec / 60)} 分钟。分析可能需要 1-2 分钟，请耐心等待。`)
      }
    }
    tempVideo.src = URL.createObjectURL(file)

    setVideoFile(file)
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl)
    }
    setVideoPreviewUrl(URL.createObjectURL(file))
  }, [videoPreviewUrl])

  const handleScriptSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setScriptFile(file)
    }
  }, [])

  const handlePptScriptSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setPptScriptFile(file)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (videoPreviewUrl) {
        URL.revokeObjectURL(videoPreviewUrl)
      }
    }
  }, [videoPreviewUrl])

  const handleStart = async () => {
    setIsCreating(true)
    try {
      if (selectedMode === 'upload') {
        if (!videoFile) {
          alert('请先选择要分析的视频文件')
          return
        }

        const result = await createSession('upload')
        // Navigate immediately for local playback; upload & analysis start in Review page.
        navigate(`/review/${result.id}`, { state: { localVideoFile: videoFile } })
        return
      }

      if (selectedMode === 'ppt_analysis') {
        if (!pptFile) {
          alert('请先选择要分析的 PPT/PDF 文件')
          return
        }
        const result = await createSession('ppt_analysis', undefined, pptFile)
        navigate(`/review/${result.id}`)
        return
      }

      if (selectedMode === 'script_analysis') {
        if (!scriptFile) {
          alert('请先选择要分析的演讲稿文件')
          return
        }
        const result = await createSession('script_analysis')
        await uploadScript(result.id, scriptFile)
        navigate(`/review/${result.id}`)
        return
      }

      const result = await createSession(
        selectedMode,
        undefined,
        selectedMode === 'ppt' ? pptFile || undefined : undefined
      )

      // Optional: user-provided per-slide script for PPT mode
      if (selectedMode === 'ppt' && pptScriptFile) {
        try {
          await uploadPptScript(result.id, pptScriptFile)
        } catch (e) {
          // Keep going; PPT practice can still start.
          console.warn('Failed to upload ppt script:', e)
        }
      }

      if (selectedMode === 'script') {
        if (!scriptFile) {
          alert('请先选择演讲稿文件')
          return
        }
        await uploadScript(result.id, scriptFile)
      }
      navigate(`/practice/${result.id}`)
    } catch (error) {
      console.error('Failed to create session:', error)
      alert('创建会话失败，请检查后端服务是否运行')
    } finally {
      setIsCreating(false)
    }
  }

  const canStart =
    ((selectedMode !== 'ppt' && selectedMode !== 'ppt_analysis') || pptFile !== null) &&
    (selectedMode !== 'upload' || videoFile !== null) &&
    ((selectedMode !== 'script' && selectedMode !== 'script_analysis') || scriptFile !== null)

  return (
    <div className="min-h-screen bg-neutral-50 py-12">
      <div className="max-w-4xl mx-auto px-6">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="text-4xl font-bold text-primary mb-4">
            AI 演说家
          </h1>
          <p className="text-lg text-neutral-500 max-w-2xl mx-auto whitespace-nowrap">
            基于多模态大模型的智能演讲辅导平台，实时反馈、深度分析、助你成为更好的演讲者
          </p>
        </motion.div>

        {/* 演讲练习模式 */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-neutral-700 mb-3 flex items-center gap-2">
            <Mic className="w-5 h-5 text-primary" />
            演讲练习模式
            <span className="text-xs font-normal text-neutral-400">需要摄像头/麦克风</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {practiceModes.map((mode, index) => (
              <motion.button
                key={mode.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => setSelectedMode(mode.id)}
                className={`
                  relative p-5 rounded-2xl text-left transition-all duration-200
                  ${selectedMode === mode.id
                    ? 'bg-white shadow-glass ring-2 ring-primary'
                    : 'bg-white/50 hover:bg-white hover:shadow-soft'
                  }
                `}
              >
                {mode.recommended && (
                  <span className="absolute top-3 right-3 flex items-center gap-1 text-xs font-medium text-accent-success bg-accent-success/10 px-2 py-1 rounded-full">
                    <Sparkles className="w-3 h-3" />
                    推荐
                  </span>
                )}
                <div className={`
                  w-10 h-10 rounded-xl flex items-center justify-center mb-3
                  ${selectedMode === mode.id ? 'bg-primary text-white' : 'bg-neutral-100 text-neutral-600'}
                `}>
                  <mode.icon className="w-5 h-5" />
                </div>
                <h3 className="text-base font-semibold text-primary mb-1">
                  {mode.title}
                </h3>
                <p className="text-xs text-neutral-500 leading-relaxed">
                  {mode.description}
                </p>
              </motion.button>
            ))}
          </div>
        </div>

        {/* 文件分析模式 */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-neutral-700 mb-3 flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            文件分析模式
            <span className="text-xs font-normal text-neutral-400">仅分析，不录制</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {analysisModes.map((mode, index) => (
              <motion.button
                key={mode.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + index * 0.05 }}
                onClick={() => setSelectedMode(mode.id)}
                className={`
                  relative p-5 rounded-2xl text-left transition-all duration-200
                  ${selectedMode === mode.id
                    ? 'bg-white shadow-glass ring-2 ring-primary'
                    : 'bg-white/50 hover:bg-white hover:shadow-soft'
                  }
              `}
              >
                <div className={`
                w-10 h-10 rounded-xl flex items-center justify-center mb-3
                ${selectedMode === mode.id ? 'bg-primary text-white' : 'bg-neutral-100 text-neutral-600'}
              `}>
                  <mode.icon className="w-5 h-5" />
                </div>
                <h3 className="text-base font-semibold text-primary mb-1">
                  {mode.title}
                </h3>
                <p className="text-xs text-neutral-500 leading-relaxed">
                  {mode.description}
                </p>
              </motion.button>
            ))}
          </div>
        </div>

        {/* File Upload Area */}
        <div className="card mb-10">
          {selectedMode === 'ppt' || selectedMode === 'ppt_analysis' ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="font-medium text-neutral-800">上传 PPT / PDF</div>
                  <div className="text-xs text-neutral-500">PPT 模式将自动导出为图片并生成提词内容</div>
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="btn-secondary flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  选择文件
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".ppt,.pptx,.pdf"
                onChange={handleFileSelect}
                className="hidden"
              />
              {pptFile && (
                <div className="text-sm text-neutral-600">已选择：{pptFile.name}</div>
              )}

              {selectedMode === 'ppt' && (
                <div className="mt-6 pt-6 border-t border-neutral-100">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="font-medium text-neutral-800">逐字稿（可选）</div>
                      <div className="text-xs text-neutral-500">用于按页绑定你的讲稿；推荐每页之间用一行 --- 分隔</div>
                    </div>
                    <button
                      onClick={() => pptScriptInputRef.current?.click()}
                      className="btn-secondary flex items-center gap-2"
                    >
                      <FileText className="w-4 h-4" />
                      选择逐字稿
                    </button>
                  </div>
                  <input
                    ref={pptScriptInputRef}
                    type="file"
                    accept=".txt,.md,.doc,.docx"
                    onChange={handlePptScriptSelect}
                    className="hidden"
                  />
                  {pptScriptFile ? (
                    <div className="text-sm text-neutral-600">已选择：{pptScriptFile.name}</div>
                  ) : (
                    <div className="text-sm text-neutral-400">未选择（将使用 AI 生成提词稿或 PPT 备注）</div>
                  )}
                </div>
              )}
            </>
          ) : null}

          {selectedMode === 'script' || selectedMode === 'script_analysis' ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="font-medium text-neutral-800">上传演讲稿</div>
                  <div className="text-xs text-neutral-500">支持 Word / TXT / Markdown</div>
                </div>
                <button
                  onClick={() => scriptInputRef.current?.click()}
                  className="btn-secondary flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  选择文件
                </button>
              </div>
              <input
                ref={scriptInputRef}
                type="file"
                accept=".txt,.md,.doc,.docx"
                onChange={handleScriptSelect}
                className="hidden"
              />
              {scriptFile && (
                <div className="text-sm text-neutral-600">已选择：{scriptFile.name}</div>
              )}
            </>
          ) : null}

          {selectedMode === 'upload' ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="font-medium text-neutral-800">上传演讲视频</div>
                  <div className="text-xs text-neutral-500">选择文件后将立即进入播放与渐进分析</div>
                </div>
                <button
                  onClick={() => videoInputRef.current?.click()}
                  className="btn-secondary flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  选择视频
                </button>
              </div>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                onChange={handleVideoSelect}
                className="hidden"
              />
              {videoFile && (
                <div className="text-sm text-neutral-600">已选择：{videoFile.name}</div>
              )}
            </>
          ) : null}

          <div className="mt-6 flex justify-end">
            <button
              onClick={handleStart}
              disabled={!canStart || isCreating}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {isCreating ? '创建中...' : '开始'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Recent Sessions */}
        {recentSessions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mb-12"
          >
            <h2 className="text-xl font-bold text-neutral-800 mb-4 px-1">最近练习记录</h2>
            <div className="bg-white rounded-2xl shadow-sm border border-neutral-100 divide-y divide-neutral-50 overflow-hidden">
              {recentSessions.map((session) => (
                <div
                  key={session.id}
                  className="p-4 flex items-center justify-between hover:bg-neutral-50 transition-colors cursor-pointer group"
                  onClick={() => {
                    if (session.mode === 'ppt' || session.mode === 'upload') {
                      navigate(`/practice/${session.id}`) // Or review based on status
                    } else {
                      navigate(`/review/${session.id}`)
                    }
                  }}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${session.status === 'completed' ? 'bg-green-100 text-green-600' :
                      session.status === 'analyzing' ? 'bg-blue-100 text-blue-600' :
                        session.status === 'error' ? 'bg-red-100 text-red-600' :
                          'bg-neutral-100 text-neutral-500'
                      }`}>
                      {session.mode === 'ppt_analysis' ? <Presentation className="w-5 h-5" /> :
                        session.mode === 'script_analysis' ? <FileText className="w-5 h-5" /> :
                          <Play className="w-5 h-5" />}
                    </div>
                    <div>
                      <div className="font-medium text-neutral-800 flex items-center gap-2">
                        {session.title || (
                          session.mode === 'ppt_analysis' ? 'PPT 备稿分析' :
                            session.mode === 'script_analysis' ? '演讲稿分析' :
                              session.mode === 'ppt' ? 'PPT 演讲练习' : '自由演讲练习'
                        )}
                        {session.status === 'analyzing' && (
                          <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full animate-pulse border border-blue-100">AI 分析中...</span>
                        )}
                        {session.status === 'error' && (
                          <span className="text-xs px-2 py-0.5 bg-red-50 text-red-600 rounded-full border border-red-100">失败</span>
                        )}
                      </div>
                      <div className="text-xs text-neutral-500 mt-1">
                        {new Date(session.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className="text-neutral-400 group-hover:text-primary transition-colors">
                    <ArrowRight className="w-5 h-5" />
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
        {/* Quick Stats */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-16 grid grid-cols-3 gap-6 text-center"
        >
          <div className="p-6">
            <p className="text-3xl font-bold text-primary mb-2">AI 实时教练</p>
            <p className="text-sm text-neutral-500">边讲边纠偏：HUD 弱提示 + 可选语音插话，语速/低头/偏离镜头即时提醒</p>
          </div>
          <div className="p-6">
            <p className="text-3xl font-bold text-primary mb-2">多模态评估</p>
            <p className="text-sm text-neutral-500">语音（语速/口头禅/情绪）+ 视觉（姿态/头部/表情）融合评估，结果带时间戳证据</p>
          </div>
          <div className="p-6">
            <p className="text-3xl font-bold text-primary mb-2">隐私优先</p>
            <p className="text-sm text-neutral-500">本地录制与存储为主，随时一键删除；AI 分析仅上传必要帧与摘要</p>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
