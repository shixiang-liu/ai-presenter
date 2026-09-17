import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, Clock, Star, Trash2, BarChart3, User, GitCompare, CheckSquare, Square, RotateCcw } from 'lucide-react'
import { motion } from 'framer-motion'
import { listSessions, deleteSession, deleteAllSessions, type Session } from '../../services/api'

export default function HistoryPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  useEffect(() => {
    loadSessions()
  }, [])

  async function loadSessions() {
    try {
      const data = await listSessions()
      setSessions(data.sessions)
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(e: React.MouseEvent, sessionId: string) {
    e.preventDefault()
    e.stopPropagation()

    if (!confirm('确定要删除这次练习记录吗？')) return

    try {
      await deleteSession(sessionId)
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    } catch (err) {
      alert('删除失败')
    }
  }

  async function handleBatchDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`确定要删除选中的 ${selectedIds.size} 条记录吗？删除后无法恢复。`)) return

    setIsDeleting(true)
    try {
      const deletePromises = Array.from(selectedIds).map(id => deleteSession(id))
      await Promise.all(deletePromises)
      setSessions(prev => prev.filter(s => !selectedIds.has(s.id)))
      setSelectedIds(new Set())
    } catch (err) {
      alert('部分删除失败')
      loadSessions() // Reload to get accurate state
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleResetAll() {
    if (!confirm('⚠️ 确定要清空所有练习数据吗？\n\n此操作将删除所有历史记录、视频、分析报告，且无法恢复！')) return
    if (!confirm('再次确认：您确定要恢复出厂设置吗？')) return

    setIsResetting(true)
    try {
      const result = await deleteAllSessions()
      alert(`${result.message}\n共删除 ${result.deleted_count} 条记录`)
      setSessions([])
      setSelectedIds(new Set())
    } catch (err) {
      alert('恢复出厂设置失败')
      loadSessions()
    } finally {
      setIsResetting(false)
    }
  }

  function toggleSelect(sessionId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === sessions.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sessions.map(s => s.id)))
    }
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const formatDuration = (ms?: number) => {
    if (!ms) return '--:--'
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  const getModeLabel = (mode: string) => {
    const labels: Record<string, string> = {
      ppt: 'PPT 演示',
      free: '自由演讲',
      script: '演讲稿',
      upload: '视频分析',
      ppt_analysis: 'PPT 分析',
      script_analysis: '稿件分析',
    }
    return labels[mode] || mode
  }

  const getStatusInfo = (session: Session) => {
    if (session.status === 'completed') {
      return { label: '已完成', color: 'text-accent-success', bg: 'bg-accent-success/10' }
    } else if (session.status === 'analyzing') {
      return { label: 'AI 分析中', color: 'text-blue-600', bg: 'bg-blue-50' }
    } else if (session.status === 'error') {
      return { label: '分析失败', color: 'text-accent-error', bg: 'bg-accent-error/10' }
    } else if (session.status === 'pending') {
      return { label: '待处理', color: 'text-neutral-500', bg: 'bg-neutral-100' }
    } else {
      // Unknown or recording status
      return { label: '未评分', color: 'text-neutral-400', bg: 'bg-neutral-100' }
    }
  }

  const getUnscoreReason = (session: Session) => {
    if (session.status === 'error') {
      return '分析过程中出现错误，可能是视频格式不支持或网络问题'
    } else if (session.status === 'analyzing') {
      return 'AI 正在分析中，请稍候'
    } else if (session.status === 'pending' || session.status === 'recording') {
      return '练习未完成或未触发分析'
    }
    return '暂无评分数据'
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-50 py-12">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center text-neutral-500">加载中...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-50 py-12">
      <div className="max-w-4xl mx-auto px-6">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-primary">历史记录</h1>
          <div className="flex items-center gap-3">
            <Link
              to="/profile"
              className="flex items-center gap-2 px-4 py-2 bg-white rounded-xl shadow-soft hover:shadow-glass text-neutral-600 hover:text-primary transition-all"
            >
              <User className="w-4 h-4" />
              <span className="text-sm font-medium">演讲者画像</span>
            </Link>
            <Link
              to="/compare"
              className="flex items-center gap-2 px-4 py-2 bg-white rounded-xl shadow-soft hover:shadow-glass text-neutral-600 hover:text-primary transition-all"
            >
              <GitCompare className="w-4 h-4" />
              <span className="text-sm font-medium">横向对比</span>
            </Link>
            <Link to="/" className="btn-primary">
              新建练习
            </Link>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="card text-center py-16">
            <BarChart3 className="w-16 h-16 text-neutral-300 mx-auto mb-4" />
            <p className="text-lg text-neutral-500 mb-4">
              还没有练习记录
            </p>
            <Link to="/" className="btn-primary">
              开始第一次练习
            </Link>
          </div>
        ) : (
          <>
            {/* Batch Actions Bar */}
            <div className="flex items-center justify-between mb-4 p-3 bg-white rounded-xl shadow-soft">
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleSelectAll}
                  className="flex items-center gap-2 text-sm text-neutral-600 hover:text-primary transition-colors"
                >
                  {selectedIds.size === sessions.length ? (
                    <CheckSquare className="w-5 h-5 text-primary" />
                  ) : (
                    <Square className="w-5 h-5" />
                  )}
                  {selectedIds.size === sessions.length ? '取消全选' : '全选'}
                </button>
                {selectedIds.size > 0 && (
                  <span className="text-sm text-neutral-500">
                    已选择 {selectedIds.size} 项
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {selectedIds.size > 0 && (
                  <button
                    onClick={handleBatchDelete}
                    disabled={isDeleting}
                    className="flex items-center gap-2 px-4 py-2 bg-accent-error/10 text-accent-error rounded-lg hover:bg-accent-error/20 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                    {isDeleting ? '删除中...' : `删除选中 (${selectedIds.size})`}
                  </button>
                )}

                {/* Reset All Button */}
                <button
                  onClick={handleResetAll}
                  disabled={isResetting}
                  className="flex items-center gap-2 px-3 py-2 text-neutral-500 hover:text-accent-error hover:bg-accent-error/5 rounded-lg transition-colors disabled:opacity-50"
                  title="清空所有数据，恢复出厂设置"
                >
                  <RotateCcw className="w-4 h-4" />
                  {isResetting ? '重置中...' : '恢复出厂'}
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {sessions.map((session, index) => {
                const statusInfo = getStatusInfo(session)
                const isSelected = selectedIds.has(session.id)

                return (
                  <motion.div
                    key={session.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <div
                      className={`
                        card flex items-center gap-6 transition-all duration-200
                        ${isSelected ? 'ring-2 ring-primary bg-primary/5' : ''}
                        hover:shadow-glass cursor-pointer
                      `}
                      onClick={() => {
                        if (session.status === 'completed' || session.status === 'analyzing') {
                          window.location.href = `/review/${session.id}`
                        }
                      }}
                    >
                      {/* Checkbox */}
                      <div
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleSelect(session.id)
                        }}
                        className="flex-shrink-0 p-1 cursor-pointer"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-5 h-5 text-primary" />
                        ) : (
                          <Square className="w-5 h-5 text-neutral-400 hover:text-neutral-600" />
                        )}
                      </div>

                      {/* Score */}
                      <div className="flex-shrink-0 w-20 h-20 rounded-2xl bg-neutral-50 flex flex-col items-center justify-center">
                        {session.total_score ? (
                          <>
                            <span className="text-2xl font-bold text-primary">
                              {Math.round(session.total_score)}
                            </span>
                            <span className="text-xs text-neutral-400">分</span>
                          </>
                        ) : (
                          <div className="text-center group relative">
                            <span className={`text-sm ${statusInfo.color}`}>
                              {statusInfo.label}
                            </span>
                            {/* Tooltip for unscore reason */}
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-neutral-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none max-w-[200px] text-center">
                              {getUnscoreReason(session)}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-primary mb-1 truncate">
                          {session.title || `练习 ${session.id}`}
                        </h3>
                        <div className="flex items-center gap-4 text-sm text-neutral-500">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-4 h-4" />
                            {formatDate(session.created_at)}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-4 h-4" />
                            {formatDuration(session.duration_ms)}
                          </span>
                          <span className="px-2 py-0.5 bg-neutral-100 rounded-full text-xs">
                            {getModeLabel(session.mode)}
                          </span>
                          {session.status !== 'completed' && (
                            <span className={`px-2 py-0.5 rounded-full text-xs ${statusInfo.bg} ${statusInfo.color}`}>
                              {statusInfo.label}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2">
                        {session.total_score && session.total_score >= 80 && (
                          <Star className="w-5 h-5 text-accent-warning fill-accent-warning" />
                        )}
                        <button
                          onClick={(e) => handleDelete(e, session.id)}
                          className="p-2 rounded-lg hover:bg-neutral-100 text-neutral-400 hover:text-accent-error"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
