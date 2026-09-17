import { useEffect, useRef, useState } from 'react'

export default function useTypewriterText(text: string, options?: { cps?: number; maxStep?: number }) {
  const cps = options?.cps ?? 40 // characters per second
  const maxStep = options?.maxStep ?? 8

  const [display, setDisplay] = useState('')
  const targetRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number>(0)

  useEffect(() => {
    const next = (text || '').trim()
    targetRef.current = next

    const findCommonPrefixLen = (a: string, b: string) => {
      const max = Math.min(a.length, b.length)
      let i = 0
      for (; i < max; i += 1) {
        if (a[i] !== b[i]) break
      }
      return i
    }

    setDisplay((prev) => {
      if (!next) return ''
      if (!prev) return ''
      const lcp = findCommonPrefixLen(prev, next)
      return prev.slice(0, lcp)
    })

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    lastTsRef.current = 0

    const tick = (ts: number) => {
      const target = targetRef.current
      if (!target) {
        setDisplay('')
        return
      }

      setDisplay((prev) => {
        if (prev === target) return prev
        if (!target.startsWith(prev)) {
          const lcp = findCommonPrefixLen(prev, target)
          return prev.slice(0, lcp)
        }

        const lastTs = lastTsRef.current || ts
        const dt = Math.max(0, ts - lastTs)
        lastTsRef.current = ts

        const step = Math.max(1, Math.min(maxStep, Math.floor((dt / 1000) * cps)))
        return target.slice(0, Math.min(target.length, prev.length + step))
      })

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [text, cps, maxStep])

  return display
}
