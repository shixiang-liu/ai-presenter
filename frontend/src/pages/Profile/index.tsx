/**
 * Speaker Profile Page
 * Long-term speaker analysis and improvement tracking
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
    User, TrendingUp, AlertTriangle, Star,
    Target, Calendar, ChevronLeft, Sparkles, Check
} from 'lucide-react'
import { motion } from 'framer-motion'
import {
    LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
    RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar
} from 'recharts'
import { getProfile } from '../../services/api'

type ProfileData = Awaited<ReturnType<typeof getProfile>>

export default function ProfilePage() {
    const [loading, setLoading] = useState(true)
    const [profile, setProfile] = useState<ProfileData | null>(null)

    useEffect(() => {
        loadProfile()
    }, [])

    async function loadProfile() {
        try {
            const data = await getProfile()
            setProfile(data)
        } catch (err) {
            console.error('Failed to load profile:', err)
        } finally {
            setLoading(false)
        }
    }

    const formatDuration = (ms: number) => {
        const minutes = Math.floor(ms / 1000 / 60)
        if (minutes < 60) return `${minutes} 分钟`
        const hours = Math.floor(minutes / 60)
        const mins = minutes % 60
        return `${hours} 小时 ${mins} 分钟`
    }

    if (loading) {
        return (
            <div className="min-h-screen bg-neutral-50 py-12">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center text-neutral-500">加载中...</div>
                </div>
            </div>
        )
    }

    if (!profile || profile.totalSessions === 0) {
        return (
            <div className="min-h-screen bg-neutral-50 py-12">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="flex items-center gap-4 mb-8">
                        <Link to="/history" className="p-2 rounded-xl bg-white shadow-soft hover:shadow-glass">
                            <ChevronLeft className="w-5 h-5" />
                        </Link>
                        <h1 className="text-2xl font-bold text-primary">演讲者画像</h1>
                    </div>
                    <div className="card text-center py-16">
                        <User className="w-16 h-16 text-neutral-300 mx-auto mb-4" />
                        <p className="text-lg text-neutral-500 mb-4">
                            需要至少完成一次练习才能生成画像
                        </p>
                        <Link to="/" className="btn-primary">
                            开始第一次练习
                        </Link>
                    </div>
                </div>
            </div>
        )
    }

    const s: any = (profile as any).avgScores || null
    const fallback = Math.min(100, profile.avgScore)
    const radarData = [
        { subject: '逻辑', value: Math.min(100, s?.logic ?? fallback) },
        { subject: '流畅度', value: Math.min(100, s?.fluency ?? fallback) },
        { subject: '肢体', value: Math.min(100, s?.delivery ?? fallback) },
        { subject: '情感', value: Math.min(100, s?.emotion ?? fallback) },
        { subject: '节奏', value: Math.min(100, s?.pacing ?? fallback) },
    ]

    return (
        <div className="min-h-screen bg-neutral-50 py-12">
            <div className="max-w-6xl mx-auto px-6">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-4">
                        <Link to="/history" className="p-2 rounded-xl bg-white shadow-soft hover:shadow-glass">
                            <ChevronLeft className="w-5 h-5" />
                        </Link>
                        <div>
                            <h1 className="text-2xl font-bold text-primary">演讲者画像</h1>
                            <p className="text-sm text-neutral-500">基于 {profile.totalSessions} 次练习的综合分析</p>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-6">
                    {/* Left Column - Stats & Radar */}
                    <div className="space-y-6">
                        {/* Quick Stats */}
                        <div className="grid grid-cols-2 gap-4">
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="card text-center"
                            >
                                <div className="text-3xl font-bold text-primary mb-1">{profile.totalSessions}</div>
                                <div className="text-sm text-neutral-500">练习次数</div>
                            </motion.div>
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.1 }}
                                className="card text-center"
                            >
                                <div className="text-3xl font-bold text-accent-success mb-1">{profile.avgScore}</div>
                                <div className="text-sm text-neutral-500">平均分</div>
                            </motion.div>
                        </div>

                        {/* Style Tags */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.2 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-4 flex items-center gap-2">
                                <Sparkles className="w-4 h-4 text-accent-warning" />
                                演讲风格
                            </h3>
                            <div className="flex flex-wrap gap-2">
                                {profile.styleTags.map((tag, i) => (
                                    <span
                                        key={i}
                                        className="px-3 py-1.5 bg-gradient-to-r from-primary/10 to-accent-success/10 text-primary rounded-full text-sm font-medium"
                                    >
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        </motion.div>

                        {/* Average Performance Radar */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.3 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-4">综合能力</h3>
                            <ResponsiveContainer width="100%" height={220}>
                                <RadarChart data={radarData}>
                                    <PolarGrid stroke="#E5E7EB" />
                                    <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11, fill: '#64748B' }} />
                                    <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                                    <Radar
                                        dataKey="value"
                                        stroke="#10B981"
                                        fill="#10B981"
                                        fillOpacity={0.25}
                                        strokeWidth={2}
                                    />
                                </RadarChart>
                            </ResponsiveContainer>
                        </motion.div>
                    </div>

                    {/* Middle Column - Score Trend & Issues */}
                    <div className="space-y-6">
                        {/* Score Trend */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.2 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-4 flex items-center gap-2">
                                <TrendingUp className="w-4 h-4 text-accent-success" />
                                成长曲线
                            </h3>
                            <ResponsiveContainer width="100%" height={200}>
                                <LineChart
                                    data={profile.scoreHistory.map((p) => ({
                                        date: new Date(p.date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
                                        score: p.score,
                                    }))}
                                >
                                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                                    <Tooltip />
                                    <Line
                                        type="monotone"
                                        dataKey="score"
                                        stroke="#10B981"
                                        strokeWidth={2}
                                        dot={{ fill: '#10B981', strokeWidth: 2 }}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </motion.div>

                        {/* Common Issues */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.3 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-4 flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4 text-accent-error" />
                                习惯性问题
                            </h3>
                            <div className="space-y-3">
                                {profile.commonIssues.map((item, i) => (
                                    <div key={i} className="flex items-center gap-3">
                                        <div className="flex-1">
                                            <div className="flex justify-between mb-1">
                                                <span className="text-sm text-neutral-700">{item.issue}</span>
                                                <span className="text-xs text-neutral-400">{item.count} 次</span>
                                            </div>
                                            <div className="h-2 bg-neutral-100 rounded-full overflow-hidden">
                                                <motion.div
                                                    initial={{ width: 0 }}
                                                    animate={{ width: `${item.percentage}%` }}
                                                    transition={{ delay: 0.5 + i * 0.1 }}
                                                    className="h-full bg-accent-error/70 rounded-full"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.div>

                        {/* Weekly Focus */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.4 }}
                            className="card bg-gradient-to-br from-primary/5 to-accent-success/5"
                        >
                            <h3 className="font-semibold text-primary mb-3 flex items-center gap-2">
                                <Target className="w-4 h-4" />
                                本周训练重点
                            </h3>
                            <p className="text-sm text-neutral-600 leading-relaxed">
                                {profile.weeklyFocus}
                            </p>
                        </motion.div>
                    </div>

                    {/* Right Column - Milestones & Strengths */}
                    <div className="space-y-6">
                        {/* Milestones */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.3 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-4 flex items-center gap-2">
                                <Star className="w-4 h-4 text-accent-warning" />
                                里程碑
                            </h3>
                            <div className="space-y-3">
                                {profile.milestones.map((milestone, i) => (
                                    <div
                                        key={i}
                                        className={`flex items-center gap-3 p-3 rounded-xl ${milestone.achieved
                                            ? 'bg-accent-success/10'
                                            : 'bg-neutral-50'
                                            }`}
                                    >
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${milestone.achieved
                                            ? 'bg-accent-success text-white'
                                            : 'bg-neutral-200 text-neutral-400'
                                            }`}>
                                            {milestone.achieved ? <Check className="w-4 h-4" /> : i + 1}
                                        </div>
                                        <div className="flex-1">
                                            <p className={`text-sm font-medium ${milestone.achieved ? 'text-neutral-700' : 'text-neutral-400'
                                                }`}>
                                                {milestone.title}
                                            </p>
                                            {milestone.achieved && milestone.date && (
                                                <p className="text-xs text-neutral-400">{milestone.date}</p>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.div>

                        {/* Strengths */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.4 }}
                            className="card"
                        >
                            <h3 className="font-semibold text-primary mb-4">你的优势</h3>
                            <div className="space-y-2">
                                {profile.strengths.map((strength, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center gap-2 p-3 bg-accent-success/10 rounded-xl"
                                    >
                                        <div className="w-6 h-6 bg-accent-success rounded-full flex items-center justify-center">
                                            <Star className="w-3 h-3 text-white" />
                                        </div>
                                        <span className="text-sm text-neutral-700">{strength}</span>
                                    </div>
                                ))}
                            </div>
                        </motion.div>

                        {/* Total Duration */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.5 }}
                            className="card text-center"
                        >
                            <Calendar className="w-8 h-8 text-primary mx-auto mb-2" />
                            <div className="text-2xl font-bold text-primary mb-1">
                                {formatDuration(profile.totalDuration)}
                            </div>
                            <div className="text-sm text-neutral-500">累计练习时长</div>
                        </motion.div>
                    </div>
                </div>
            </div>
        </div>
    )
}
