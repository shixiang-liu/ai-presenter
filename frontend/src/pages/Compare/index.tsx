/**
 * Session Comparison Page
 * Side-by-side comparison of two practice sessions
 */
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
    ChevronLeft, ArrowRight, TrendingUp, TrendingDown, Minus,
    Clock, MessageSquare, Gauge
} from 'lucide-react'
import { motion } from 'framer-motion'
import {
    BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend
} from 'recharts'
import { listSessions, compareSessions, type Session } from '../../services/api'

interface ComparisonData {
    session1: {
        info: Session
        metrics: Record<string, unknown>
        event_summary: {
            total_issues: number
            total_highlights: number
            by_category: Record<string, number>
        }
    }
    session2: {
        info: Session
        metrics: Record<string, unknown>
        event_summary: {
            total_issues: number
            total_highlights: number
            by_category: Record<string, number>
        }
    }
}

export default function ComparePage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [sessions, setSessions] = useState<Session[]>([])
    const [loading, setLoading] = useState(true)
    const [comparing, setComparing] = useState(false)
    const [comparisonData, setComparisonData] = useState<ComparisonData | null>(null)

    const [selectedId1, setSelectedId1] = useState<string>(searchParams.get('s1') || '')
    const [selectedId2, setSelectedId2] = useState<string>(searchParams.get('s2') || '')

    useEffect(() => {
        loadSessions()
    }, [])

    useEffect(() => {
        if (selectedId1 && selectedId2 && selectedId1 !== selectedId2) {
            runComparison()
        }
    }, [selectedId1, selectedId2])

    async function loadSessions() {
        try {
            const data = await listSessions()
            const completed = data.sessions.filter(s => s.status === 'completed' && s.total_score)
            setSessions(completed)

            // Auto-select last two if available
            if (completed.length >= 2 && !selectedId1 && !selectedId2) {
                setSelectedId1(completed[0].id)
                setSelectedId2(completed[1].id)
            }
        } catch (err) {
            console.error('Failed to load sessions:', err)
        } finally {
            setLoading(false)
        }
    }

    async function runComparison() {
        setComparing(true)
        try {
            const data = await compareSessions(selectedId1, selectedId2) as ComparisonData
            setComparisonData(data)
            setSearchParams({ s1: selectedId1, s2: selectedId2 })
        } catch (err) {
            console.error('Comparison failed:', err)
        } finally {
            setComparing(false)
        }
    }

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('zh-CN', {
            month: 'short',
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

    const getDiff = (v1: number, v2: number) => {
        const diff = Math.round((v2 - v1) * 10) / 10  // 保留一位小数
        if (diff > 0) return { icon: TrendingUp, color: 'text-accent-success', text: `+${diff}` }
        if (diff < 0) return { icon: TrendingDown, color: 'text-accent-error', text: `${diff}` }
        return { icon: Minus, color: 'text-neutral-400', text: '0' }
    }

    const by1: Record<string, number> = (comparisonData?.session1?.event_summary as any)?.by_category || {}
    const by2: Record<string, number> = (comparisonData?.session2?.event_summary as any)?.by_category || {}
    const get1 = (k: string) => by1[k] || 0
    const get2 = (k: string) => by2[k] || 0

    if (loading) {
        return (
            <div className="min-h-screen bg-neutral-50 py-12">
                <div className="max-w-6xl mx-auto px-6 text-center text-neutral-500">
                    加载中...
                </div>
            </div>
        )
    }

    if (sessions.length < 2) {
        return (
            <div className="min-h-screen bg-neutral-50 py-12">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="flex items-center gap-4 mb-8">
                        <Link to="/history" className="p-2 rounded-xl bg-white shadow-soft hover:shadow-glass">
                            <ChevronLeft className="w-5 h-5" />
                        </Link>
                        <h1 className="text-2xl font-bold text-primary">横向对比</h1>
                    </div>
                    <div className="card text-center py-16">
                        <p className="text-lg text-neutral-500 mb-4">
                            需要至少完成两次练习才能进行对比
                        </p>
                        <Link to="/" className="btn-primary">
                            开始练习
                        </Link>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-neutral-50 py-12">
            <div className="max-w-6xl mx-auto px-6">
                {/* Header */}
                <div className="flex items-center gap-4 mb-8">
                    <Link to="/history" className="p-2 rounded-xl bg-white shadow-soft hover:shadow-glass">
                        <ChevronLeft className="w-5 h-5" />
                    </Link>
                    <h1 className="text-2xl font-bold text-primary">横向对比</h1>
                </div>

                {/* Session Selectors */}
                <div className="card mb-8">
                    <div className="flex items-center gap-6">
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-neutral-500 mb-2">对比项 A</label>
                            <select
                                value={selectedId1}
                                onChange={(e) => setSelectedId1(e.target.value)}
                                className="input"
                            >
                                <option value="">选择练习记录</option>
                                {sessions.map(s => (
                                    <option key={s.id} value={s.id} disabled={s.id === selectedId2}>
                                        {formatDate(s.created_at)} - {s.title || '练习'} ({s.total_score}分)
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="flex items-center justify-center w-12 h-12 bg-neutral-100 rounded-full">
                            <ArrowRight className="w-5 h-5 text-neutral-400" />
                        </div>

                        <div className="flex-1">
                            <label className="block text-sm font-medium text-neutral-500 mb-2">对比项 B</label>
                            <select
                                value={selectedId2}
                                onChange={(e) => setSelectedId2(e.target.value)}
                                className="input"
                            >
                                <option value="">选择练习记录</option>
                                {sessions.map(s => (
                                    <option key={s.id} value={s.id} disabled={s.id === selectedId1}>
                                        {formatDate(s.created_at)} - {s.title || '练习'} ({s.total_score}分)
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                {/* Comparison Results */}
                {comparing ? (
                    <div className="text-center py-16 text-neutral-500">分析中...</div>
                ) : comparisonData ? (
                    <div className="space-y-6">
                        {/* Score Comparison */}
                        <div className="grid grid-cols-3 gap-6">
                            {/* Session 1 Score */}
                            <motion.div
                                initial={{ opacity: 0, x: -20 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="card text-center"
                            >
                                <div className="text-sm text-neutral-500 mb-2">
                                    {formatDate(comparisonData.session1.info.created_at)}
                                </div>
                                <div className="text-5xl font-bold text-primary mb-2">
                                    {Math.round(comparisonData.session1.info.total_score || 0)}
                                </div>
                                <div className="text-neutral-400">分</div>
                            </motion.div>

                            {/* Difference */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.1 }}
                                className="card text-center flex flex-col justify-center"
                            >
                                {(() => {
                                    const diff = getDiff(
                                        comparisonData.session1.info.total_score || 0,
                                        comparisonData.session2.info.total_score || 0
                                    )
                                    const DiffIcon = diff.icon
                                    return (
                                        <>
                                            <DiffIcon className={`w-8 h-8 mx-auto mb-2 ${diff.color}`} />
                                            <div className={`text-3xl font-bold ${diff.color}`}>
                                                {diff.text}
                                            </div>
                                            <div className="text-sm text-neutral-400 mt-1">分数变化</div>
                                        </>
                                    )
                                })()}
                            </motion.div>

                            {/* Session 2 Score */}
                            <motion.div
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: 0.2 }}
                                className="card text-center"
                            >
                                <div className="text-sm text-neutral-500 mb-2">
                                    {formatDate(comparisonData.session2.info.created_at)}
                                </div>
                                <div className="text-5xl font-bold text-accent-success mb-2">
                                    {Math.round(comparisonData.session2.info.total_score || 0)}
                                </div>
                                <div className="text-neutral-400">分</div>
                            </motion.div>
                        </div>

                        {/* Metrics Comparison */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.3 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-6">指标对比</h3>
                            <div className="grid grid-cols-4 gap-6">
                                {/* Duration */}
                                <div className="text-center">
                                    <Clock className="w-6 h-6 mx-auto text-neutral-400 mb-2" />
                                    <div className="text-sm text-neutral-500 mb-2">时长</div>
                                    <div className="flex items-center justify-center gap-2">
                                        <span className="text-lg font-medium">
                                            {formatDuration(comparisonData.session1.info.duration_ms)}
                                        </span>
                                        <span className="text-neutral-300">vs</span>
                                        <span className="text-lg font-medium text-accent-success">
                                            {formatDuration(comparisonData.session2.info.duration_ms)}
                                        </span>
                                    </div>
                                </div>

                                {/* Filler Words */}
                                <div className="text-center">
                                    <MessageSquare className="w-6 h-6 mx-auto text-neutral-400 mb-2" />
                                    <div className="text-sm text-neutral-500 mb-2">口头禅</div>
                                    <div className="flex items-center justify-center gap-2">
                                        <span className="text-lg font-medium">
                                            {get1('filler_word')}
                                        </span>
                                        <span className="text-neutral-300">vs</span>
                                        <span className={`text-lg font-medium ${(get2('filler_word')) <
                                            (get1('filler_word'))
                                            ? 'text-accent-success'
                                            : 'text-accent-error'
                                            }`}>
                                            {get2('filler_word')}
                                        </span>
                                    </div>
                                </div>

                                {/* Speed Issues */}
                                <div className="text-center">
                                    <Gauge className="w-6 h-6 mx-auto text-neutral-400 mb-2" />
                                    <div className="text-sm text-neutral-500 mb-2">语速问题</div>
                                    <div className="flex items-center justify-center gap-2">
                                        <span className="text-lg font-medium">
                                            {get1('speed_fast') + get1('speed_slow')}
                                        </span>
                                        <span className="text-neutral-300">vs</span>
                                        <span className="text-lg font-medium text-accent-success">
                                            {get2('speed_fast') + get2('speed_slow')}
                                        </span>
                                    </div>
                                </div>

                                {/* Posture Issues */}
                                <div className="text-center">
                                    <TrendingDown className="w-6 h-6 mx-auto text-neutral-400 mb-2" />
                                    <div className="text-sm text-neutral-500 mb-2">姿态问题</div>
                                    <div className="flex items-center justify-center gap-2">
                                        <span className="text-lg font-medium">
                                            {get1('head_down') + get1('look_away')}
                                        </span>
                                        <span className="text-neutral-300">vs</span>
                                        <span className="text-lg font-medium text-accent-success">
                                            {get2('head_down') + get2('look_away')}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </motion.div>

                        {/* Bar Chart Comparison */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.4 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-4">问题分布对比</h3>
                            <ResponsiveContainer width="100%" height={250}>
                                <BarChart data={[
                                    {
                                        name: '口头禅',
                                        A: get1('filler_word'),
                                        B: get2('filler_word')
                                    },
                                    {
                                        name: '语速过快',
                                        A: get1('speed_fast'),
                                        B: get2('speed_fast')
                                    },
                                    {
                                        name: '语速过慢',
                                        A: get1('speed_slow'),
                                        B: get2('speed_slow')
                                    },
                                    {
                                        name: '低头',
                                        A: get1('head_down'),
                                        B: get2('head_down')
                                    },
                                    {
                                        name: '视线偏离',
                                        A: get1('look_away'),
                                        B: get2('look_away')
                                    },
                                ]}>
                                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                                    <YAxis tick={{ fontSize: 12 }} />
                                    <Tooltip />
                                    <Legend />
                                    <Bar dataKey="A" name="对比项 A" fill="#94A3B8" />
                                    <Bar dataKey="B" name="对比项 B" fill="#10B981" />
                                </BarChart>
                            </ResponsiveContainer>
                        </motion.div>

                        {/* Quick Actions */}
                        <div className="flex justify-center gap-4">
                            <Link
                                to={`/review/${selectedId1}`}
                                className="btn-secondary"
                            >
                                查看 A 详情
                            </Link>
                            <Link
                                to={`/review/${selectedId2}`}
                                className="btn-primary"
                            >
                                查看 B 详情
                            </Link>
                        </div>
                    </div>
                ) : (
                    <div className="text-center py-16 text-neutral-400">
                        请选择两个练习记录进行对比
                    </div>
                )}
            </div>
        </div>
    )
}
