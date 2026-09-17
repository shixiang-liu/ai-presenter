/**
 * EmotionCurveChart Component
 * Displays emotion/energy curve over time
 */
import {
    LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer
} from 'recharts'

interface EmotionCurveChartProps {
    data: Array<[number, number]>  // [time_ms, value]
    height?: number
}

function formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
}

export default function EmotionCurveChart({ data, height = 200 }: EmotionCurveChartProps) {
    const chartData = data.map(([time, value]) => ({ time, value }))

    return (
        <ResponsiveContainer width="100%" height={height}>
            <LineChart data={chartData}>
                <XAxis
                    dataKey="time"
                    tickFormatter={(v) => formatTime(v)}
                    tick={{ fontSize: 12 }}
                />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                <Tooltip
                    labelFormatter={(v) => formatTime(v as number)}
                    formatter={(v: number) => [v.toFixed(1), '能量值']}
                />
                <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#10B981"
                    strokeWidth={2}
                    dot={false}
                />
            </LineChart>
        </ResponsiveContainer>
    )
}
