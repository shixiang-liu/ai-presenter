/**
 * Global application store using Zustand
 */
import { create } from 'zustand'
import type { Session, Slide, Event, TranscriptSegment } from '../services/api'

interface PracticeState {
  // Session
  sessionId: string | null
  session: Session | null
  slides: Slide[]
  currentSlideIndex: number
  
  // Recording
  isRecording: boolean
  isPaused: boolean
  elapsedTime: number  // ms
  baseTime: number     // timestamp when recording started
  
  // Real-time data
  asrText: string
  asrTranscript: string
  asrSegments: TranscriptSegment[]
  events: Event[]
  
  // Metrics
  currentSpeed: number  // chars per minute
  fillerCount: number
  
  // Settings
  ttsEnabled: boolean
  
  // Actions
  setSession: (session: Session, slides: Slide[]) => void
  setSlideIndex: (index: number) => void
  startRecording: () => void
  stopRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  updateElapsedTime: (time: number) => void
  addAsrText: (text: string, isFinal: boolean) => void
  addAsrSegment: (segment: TranscriptSegment) => void
  addEvent: (event: Event) => void
  updateMetrics: (speed: number, fillerCount: number) => void
  toggleTts: () => void
  reset: () => void
}

export const usePracticeStore = create<PracticeState>((set) => ({
  // Initial state
  sessionId: null,
  session: null,
  slides: [],
  currentSlideIndex: 0,
  isRecording: false,
  isPaused: false,
  elapsedTime: 0,
  baseTime: 0,
  asrText: '',
  asrTranscript: '',
  asrSegments: [],
  events: [],
  currentSpeed: 0,
  fillerCount: 0,
  ttsEnabled: true,  // 默认开启语音教练
  
  // Actions
  setSession: (session, slides) => set({
    sessionId: session.id,
    session,
    slides,
    currentSlideIndex: 0,
  }),
  
  setSlideIndex: (index) => set({ currentSlideIndex: index }),
  
  startRecording: () => set({
    isRecording: true,
    isPaused: false,
    baseTime: Date.now(),
    elapsedTime: 0,
  }),
  
  stopRecording: () => set({
    isRecording: false,
    isPaused: false,
  }),
  
  pauseRecording: () => set({ isPaused: true }),
  
  resumeRecording: () => set({ isPaused: false }),
  
  updateElapsedTime: (time) => set({ elapsedTime: time }),
  
  addAsrText: (text, isFinal) => set((state) => {
    const normalized = (text || '').trim()
    if (!normalized) return { asrText: isFinal ? state.asrText : '' }

    if (!isFinal) {
      return { asrText: normalized }
    }

    const nextTranscript = state.asrTranscript
      ? `${state.asrTranscript}\n${normalized}`
      : normalized

    return {
      asrText: normalized,
      asrTranscript: nextTranscript,
    }
  }),
  
  addAsrSegment: (segment) => set((state) => ({
    asrSegments: [...state.asrSegments, segment],
  })),
  
  addEvent: (event) => set((state) => ({
    events: [...state.events, event],
    fillerCount: event.category === 'filler_word' 
      ? state.fillerCount + 1 
      : state.fillerCount,
  })),
  
  updateMetrics: (speed, fillerCount) => set({
    currentSpeed: speed,
    fillerCount,
  }),
  
  toggleTts: () => set((state) => ({ ttsEnabled: !state.ttsEnabled })),
  
  reset: () => set({
    sessionId: null,
    session: null,
    slides: [],
    currentSlideIndex: 0,
    isRecording: false,
    isPaused: false,
    elapsedTime: 0,
    baseTime: 0,
    asrText: '',
    asrTranscript: '',
    asrSegments: [],
    events: [],
    currentSpeed: 0,
    fillerCount: 0,
  }),
}))

// Review page store
interface ReviewState {
  sessionId: string | null
  currentTime: number  // ms, video playback position
  selectedEventId: number | null
  
  setSessionId: (id: string) => void
  setCurrentTime: (time: number) => void
  selectEvent: (eventId: number | null) => void
}

export const useReviewStore = create<ReviewState>((set) => ({
  sessionId: null,
  currentTime: 0,
  selectedEventId: null,
  
  setSessionId: (id) => set({ sessionId: id }),
  setCurrentTime: (time) => set({ currentTime: time }),
  selectEvent: (eventId) => set({ selectedEventId: eventId }),
}))
