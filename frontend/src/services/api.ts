/**
 * API Service - Communication with backend
 */

const API_BASE = '/api'

export interface Session {
  id: string
  created_at: string
  mode: string
  title: string
  duration_ms?: number
  video_path?: string
  status: string
  slides_count?: number
  total_score?: number
  scores_json?: string
}

export interface Slide {
  index: number
  image_path: string
  notes: string
  generated_script?: string
  analysis?: {
    title: string
    key_points: string[]
    suggested_script: string
    estimated_duration_sec: number
  }
}

export interface TranscriptSegment {
  id: number
  session_id: string
  start_ms: number
  end_ms: number
  text: string
  slide_index?: number
}

export interface Event {
  id: number
  session_id: string
  type: 'issue' | 'highlight'
  category: string
  severity: 'low' | 'medium' | 'high'
  start_ms: number
  end_ms: number
  evidence: Record<string, unknown>
  slide_index?: number
}

export interface PptPrepReport {
  outline: Array<{
    slide_index: number
    title?: string
    key_points?: string[]
    estimated_duration_sec?: number | null
  }>
  suggestions: string[]
  overall_structure?: string
  estimated_total_duration_sec?: number | null
}

export interface Report {
  // Normal analysis report fields
  scores?: {
    total: number
    fluency: number
    nonverbal: number
    emotion: number
    structure: number
    issue_counts: Record<string, number>
  }
  suggestions?: string[]
  audio_stats?: {
    f0_stats: { mean: number; std: number; range: number }
    energy_stats: { mean: number; std: number; range: number }
    monotone_segments: [number, number][]
  }
  glm_results?: Array<{
    time_ms: number
    confidence_score: number
    expression: string
    summary: string
  }>

  // PPT prep-only report
  ppt_prep?: PptPrepReport
}

export interface SpeakerProfile {
  totalSessions: number
  totalDuration: number
  avgScore: number
  scoreHistory: Array<{ date: string; score: number }>
  commonIssues: Array<{ issue: string; count: number; percentage: number }>
  strengths: string[]
  styleTags: string[]
  weeklyFocus: string
  milestones: Array<{ title: string; date: string; achieved: boolean }>
}

// Session APIs
export async function createSession(
  mode: string,
  title?: string,
  pptFile?: File
): Promise<{ id: string; slides: Slide[] }> {
  const formData = new FormData()
  formData.append('mode', mode)
  if (title) formData.append('title', title)
  if (pptFile) formData.append('ppt_file', pptFile)

  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) throw new Error('Failed to create session')
  return res.json()
}

export async function getSession(sessionId: string): Promise<{
  session: Session
  slides: Slide[]
  events: Event[]
  transcript_segments: TranscriptSegment[]
}> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`)
  if (!res.ok) throw new Error('Session not found')
  return res.json()
}

export async function listSessions(): Promise<{ sessions: Session[] }> {
  const res = await fetch(`${API_BASE}/sessions`)
  if (!res.ok) throw new Error('Failed to list sessions')
  return res.json()
}

export async function finishSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/finish`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('Failed to finish session')
}

export async function uploadVideo(sessionId: string, video: Blob, filename: string = 'video.webm'): Promise<void> {
  const formData = new FormData()
  formData.append('video', video, filename)

  const res = await fetch(`${API_BASE}/sessions/${sessionId}/upload/video`, {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) throw new Error('Failed to upload video')
}

export async function uploadScript(sessionId: string, scriptFile: File): Promise<void> {
  const formData = new FormData()
  formData.append('script', scriptFile, scriptFile.name)

  const res = await fetch(`${API_BASE}/sessions/${sessionId}/upload/script`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) throw new Error('Failed to upload script')
}

export async function uploadPptScript(sessionId: string, scriptFile: File): Promise<void> {
  const formData = new FormData()
  formData.append('script', scriptFile, scriptFile.name)

  const res = await fetch(`${API_BASE}/sessions/${sessionId}/upload/ppt_script`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) throw new Error('Failed to upload PPT script')
}

export async function getReport(sessionId: string): Promise<{
  session: Session
  report: Report
  events: Event[]
  transcript_segments: TranscriptSegment[]
  slides: Slide[]
  metrics: Record<string, Array<[number, number]>>
  slides_summary?: Array<Record<string, unknown>>
  script_text?: string
}> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/report`)
  if (!res.ok) throw new Error('Failed to get report')
  return res.json()
}

export async function exportPdf(sessionId: string): Promise<{ url: string }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/export/pdf`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to export pdf')
  return res.json()
}

export async function getProfile(): Promise<SpeakerProfile> {
  const res = await fetch(`${API_BASE}/profile`)
  if (!res.ok) throw new Error('Failed to load profile')
  return res.json()
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete session')
}

export async function deleteAllSessions(): Promise<{ deleted_count: number; message: string }> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to reset all data')
  return res.json()
}

export async function compareSessions(
  sessionId1: string,
  sessionId2: string
): Promise<{
  session1: { info: Session; metrics: Record<string, unknown>; event_summary: unknown }
  session2: { info: Session; metrics: Record<string, unknown>; event_summary: unknown }
}> {
  const res = await fetch(`${API_BASE}/sessions/compare/${sessionId1}/${sessionId2}`)
  if (!res.ok) throw new Error('Failed to compare sessions')
  return res.json()
}

export function getVideoUrl(sessionId: string): string {
  return `${API_BASE}/sessions/${sessionId}/video`
}

export function getSlideImageUrl(sessionId: string, slideIndex: number): string {
  return `${API_BASE}/sessions/${sessionId}/slides/${slideIndex}/image`
}

// WebSocket connection
export function createWebSocket(sessionId: string): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  return new WebSocket(`${protocol}//${host}/ws/sessions/${sessionId}`)
}
