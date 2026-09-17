/**
 * Audio Capture Hook
 * Uses AudioWorklet for efficient PCM extraction and resampling
 * 
 * Converts browser audio (44.1/48kHz) to 16kHz 16-bit PCM for ASR
 */
import { useRef, useCallback, useEffect } from 'react'

interface UseAudioCaptureOptions {
  onAudioData: (pcmData: ArrayBuffer) => void
  getStream?: () => Promise<MediaStream>
}

export default function useAudioCapture(options: UseAudioCaptureOptions) {
  const { onAudioData, getStream } = options

  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const sinkNodeRef = useRef<AudioNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const ownsTracksRef = useRef<boolean>(true)
  const runningRef = useRef<boolean>(false)
  const startInFlightRef = useRef<Promise<void> | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCapture()
    }
  }, [])

  const startCapture = useCallback(async () => {
    if (runningRef.current) return
    if (startInFlightRef.current) return startInFlightRef.current

    const startPromise = (async () => {
      try {
        // Get audio stream (microphone by default, or custom stream in upload mode)
        const stream = getStream
          ? await getStream()
          : await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              sampleRate: 48000,
            },
          })

        // Ensure we have an audio track
        const audioTracks = stream.getAudioTracks()
        if (!audioTracks || audioTracks.length === 0) {
          throw new Error('No audio track available')
        }

        try {
          const t = audioTracks[0]
          console.log('[audio-capture] track=', {
            label: t.label,
            readyState: t.readyState,
            enabled: t.enabled,
            muted: (t as any).muted,
          })
        } catch {
          // ignore
        }

        // Use audio-only stream for capture pipeline
        const audioOnlyStream = new MediaStream(audioTracks)
        streamRef.current = audioOnlyStream

        // If stream is provided externally (e.g., video.captureStream), do not stop its tracks on cleanup.
        // Stopping them can permanently kill the media element's audio track and break subsequent captures.
        ownsTracksRef.current = !getStream

        // Create audio context (use device/default sample rate)
        const audioContext = new AudioContext()
        audioContextRef.current = audioContext

        // Load AudioWorklet processor
        const workletCode = `
        class ResampleProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.buffer = [];
            this.inputSampleRate = sampleRate;
            this.outputSampleRate = 16000;
            this.ratio = this.inputSampleRate / this.outputSampleRate;
            this.outputBufferSize = Math.floor(128 / this.ratio) * 160; // ~160ms chunks
            this.accumulator = [];
          }

          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (!input || !input[0]) return true;

            const inputData = input[0];
            
            // Accumulate input samples
            for (let i = 0; i < inputData.length; i++) {
              this.buffer.push(inputData[i]);
            }

            // Resample when we have enough data
            // Smaller chunks = faster recognition feedback (80ms instead of 160ms)
            const targetSamples = Math.floor(this.buffer.length / this.ratio);
            if (targetSamples >= 1280) { // ~80ms at 16kHz (was 2560/160ms)
              const resampled = this.resample(this.buffer, targetSamples);
              const pcm16 = this.float32ToInt16(resampled);
              
              this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
              this.buffer = [];
            }

            return true;
          }

          resample(input, targetLength) {
            const output = new Float32Array(targetLength);
            const ratio = input.length / targetLength;

            for (let i = 0; i < targetLength; i++) {
              const srcIndex = i * ratio;
              const srcIndexFloor = Math.floor(srcIndex);
              const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
              const fraction = srcIndex - srcIndexFloor;

              // Linear interpolation
              output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction;
            }

            return output;
          }

          float32ToInt16(float32Array) {
            const int16Array = new Int16Array(float32Array.length);
            for (let i = 0; i < float32Array.length; i++) {
              // Clamp to [-1, 1] and convert to int16
              const s = Math.max(-1, Math.min(1, float32Array[i]));
              int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            return int16Array;
          }
        }

        registerProcessor('resample-processor', ResampleProcessor);
      `;

        const blob = new Blob([workletCode], { type: 'application/javascript' })
        const workletUrl = URL.createObjectURL(blob)

        await audioContext.audioWorklet.addModule(workletUrl)
        try {
          URL.revokeObjectURL(workletUrl)
        } catch {
          // ignore
        }

        // Create nodes
        const source = audioContext.createMediaStreamSource(audioOnlyStream)
        sourceNodeRef.current = source

        const workletNode = new AudioWorkletNode(audioContext, 'resample-processor')
        workletNodeRef.current = workletNode

        // Handle PCM data from worklet
        workletNode.port.onmessage = (event) => {
          onAudioData(event.data)
        }

        // Connect nodes
        source.connect(workletNode)
        // Important: connect to an output so the node is pulled/processed.
        // Worklet outputs silence by default (we don't write to outputs), so this won't echo.
        workletNode.connect(audioContext.destination)
        sinkNodeRef.current = audioContext.destination

        // Ensure context is running (especially important for media element capture)
        try {
          if (audioContext.state !== 'running') {
            await audioContext.resume()
          }
        } catch {
          // ignore
        }

        console.log('Audio capture started')

        runningRef.current = true
      } catch (err) {
        // If anything fails mid-start, make sure we don't leave partial state behind.
        try {
          stopCapture()
        } catch {
          // ignore
        }
        console.error('Failed to start audio capture:', err)
        throw err
      }
    })()

    startInFlightRef.current = startPromise
    try {
      await startPromise
    } finally {
      startInFlightRef.current = null
    }
  }, [onAudioData, getStream])

  const stopCapture = useCallback(() => {
    const wasRunning = runningRef.current || !!startInFlightRef.current
    runningRef.current = false
    startInFlightRef.current = null

    // Disconnect nodes
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect()
      sourceNodeRef.current = null
    }

    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect()
      workletNodeRef.current = null
    }

    if (sinkNodeRef.current) {
      try {
        sinkNodeRef.current.disconnect()
      } catch {
        // ignore
      }
      sinkNodeRef.current = null
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    // Stop stream tracks
    if (streamRef.current) {
      if (ownsTracksRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      streamRef.current = null
    }

    if (wasRunning) {
      console.log('Audio capture stopped')
    }
  }, [])

  const getAudioData = useCallback(() => {
    // This could be used to get accumulated audio data if needed
    return null
  }, [])

  return {
    startCapture,
    stopCapture,
    getAudioData
  }
}
