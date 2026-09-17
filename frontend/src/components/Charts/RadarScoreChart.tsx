/**
 * RadarScoreChart Component
 * Displays five-dimension scores as a radar chart
 */
import {
    RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
    ResponsiveContainer
} from 'recharts'

interface RadarScoreChartProps {
    scores: {
        logic?: number
        fluency: number
        delivery?: number
        pacing?: number
        nonverbal?: number
        emotion: number
        structure?: number
    }
    size?: number
}

export default function RadarScoreChart({ scores, size = 250 }: RadarScoreChartProps) {
    const data = [
        { subject: '逻辑', value: scores.logic ?? scores.structure ?? 0, fullMark: 100 },
        { subject: '流畅度', value: scores.fluency, fullMark: 100 },
        { subject: '肢体', value: scores.delivery ?? scores.nonverbal ?? 0, fullMark: 100 },
        { subject: '情感', value: scores.emotion, fullMark: 100 },
        { subject: '节奏', value: scores.pacing ?? scores.structure ?? 0, fullMark: 100 },
    ]

    return (
        <ResponsiveContainer width="100%" height={size}>
            <RadarChart data={data}>
                <PolarGrid />
                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12 }} />
                <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                <Radar
                    dataKey="value"
                    stroke="#0F172A"
                    fill="#0F172A"
                    fillOpacity={0.2}
                />
            </RadarChart>
        </ResponsiveContainer>
    )
}
