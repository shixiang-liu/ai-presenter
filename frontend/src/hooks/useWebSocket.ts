/**
 * WebSocket Hook for Real-time Communication
 */
import { useRef, useState, useCallback, useEffect } from 'react'

interface UseWebSocketOptions {
  url: string
  onMessage: (data: any) => void
  onError?: (error: Event) => void
  onClose?: () => void
  autoReconnect?: boolean
}

export default function useWebSocket(options: UseWebSocketOptions) {
  const { url, onMessage, onError, onClose, autoReconnect = false } = options
  
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    
    const ws = new WebSocket(url)
    wsRef.current = ws
    
    ws.onopen = () => {
      setIsConnected(true)
      console.log('WebSocket connected')
    }
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        onMessage(data)
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err)
      }
    }
    
    ws.onerror = (event) => {
      console.error('WebSocket error:', event)
      onError?.(event)
    }
    
    ws.onclose = () => {
      setIsConnected(false)
      onClose?.()
      
      if (autoReconnect) {
        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect()
        }, 3000)
      }
    }
  }, [url, onMessage, onError, onClose, autoReconnect])
  
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }
    
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    
    setIsConnected(false)
  }, [])
  
  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      if (typeof data === 'string' || data instanceof ArrayBuffer) {
        wsRef.current.send(data)
      } else {
        wsRef.current.send(JSON.stringify(data))
      }
    }
  }, [])
  
  const sendBinary = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])
  
  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])
  
  return {
    isConnected,
    connect,
    disconnect,
    send,
    sendBinary,
    ws: wsRef.current
  }
}
