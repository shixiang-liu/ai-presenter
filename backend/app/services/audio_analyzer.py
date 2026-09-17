"""
Audio Analyzer Service
Uses Librosa for acoustic feature extraction (F0, Energy, etc.)
"""
import asyncio
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import json

async def extract_audio_from_video(video_path: str, output_path: str) -> bool:
    """
    Extract audio from video using FFmpeg
    
    Args:
        video_path: Path to video file
        output_path: Path for output WAV file
    
    Returns:
        True if successful
    """
    import subprocess
    
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vn",  # No video
        "-acodec", "pcm_s16le",
        "-ar", "16000",  # 16kHz
        "-ac", "1",  # Mono
        output_path
    ]
    
    def run_ffmpeg():
        """Run FFmpeg in a synchronous subprocess"""
        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding='utf-8',
                errors='replace'
            )
            return result
        except Exception as e:
            print(f"FFmpeg subprocess error: {e}")
            return None
    
    try:
        print(f"[AudioAnalyzer] Running FFmpeg: {' '.join(cmd)}")
        result = await asyncio.to_thread(run_ffmpeg)
        
        if result is None:
            print("[AudioAnalyzer] FFmpeg subprocess returned None")
            return False
            
        if result.returncode != 0:
            print(f"[AudioAnalyzer] FFmpeg audio extraction failed (code {result.returncode}): {result.stderr[:500]}")
            return False
        
        # Verify output file exists
        if Path(output_path).exists():
            file_size = Path(output_path).stat().st_size
            print(f"[AudioAnalyzer] Audio extraction successful, file size: {file_size} bytes")
            return True
        else:
            print(f"[AudioAnalyzer] FFmpeg completed but output file not found: {output_path}")
            return False
            
    except Exception as e:
        print(f"[AudioAnalyzer] FFmpeg extraction exception: {e}")
        return False

async def analyze_audio_features(audio_path: str, window_sec: float = 1.0) -> Dict:
    """
    Analyze audio features using Librosa
    
    Args:
        audio_path: Path to audio file (WAV, 16kHz)
        window_sec: Window size for feature extraction in seconds
    
    Returns:
        {
            "duration_sec": float,
            "f0_curve": [(time_ms, f0_hz), ...],
            "energy_curve": [(time_ms, energy_db), ...],
            "f0_stats": {"mean": float, "std": float, "range": float},
            "energy_stats": {"mean": float, "std": float, "range": float},
            "monotone_segments": [(start_ms, end_ms), ...],  # F0 std < 25 Hz
            "emotion_curve": [(time_ms, energy_value_0_100), ...]
        }
    """
    result = await asyncio.to_thread(_analyze_audio_sync, audio_path, window_sec)
    return result

def _analyze_audio_sync(audio_path: str, window_sec: float) -> Dict:
    """Synchronous audio analysis (runs in thread)"""
    try:
        import librosa
        import librosa.display
    except ImportError:
        return {"error": "librosa not installed"}
    
    try:
        # Load audio (Limit to first 5 minutes to avoid timeout on long videos)
        # 16kHz is standard for speech processing
        MAX_DURATION = 300  # 5 minutes
        y, sr = librosa.load(audio_path, sr=16000, duration=MAX_DURATION)
        duration_sec = len(y) / sr
        
        if duration_sec >= MAX_DURATION:
            print(f"[Audio] Audio too long, analyzing first {MAX_DURATION}s only")
        
        # F0 extraction using pyin
        # Optimize execution speed: use larger frame_length if needed, but standard is fine for 5m
        f0, voiced_flag, voiced_probs = librosa.pyin(
            y, 
            fmin=librosa.note_to_hz('C2'),
            fmax=librosa.note_to_hz('C7'),
            sr=sr
        )
        
        # Energy (RMS)
        hop_length = 512
        rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
        
        # Convert to time series
        times = librosa.times_like(f0, sr=sr, hop_length=hop_length)
        times_ms = (times * 1000).astype(int)
        
        # F0 curve (filter out unvoiced)
        f0_curve = []
        for t, f in zip(times_ms, f0):
            if not np.isnan(f) and f > 0:
                f0_curve.append((int(t), float(f)))
        
        # Energy curve (in dB)
        rms_db = librosa.amplitude_to_db(rms, ref=np.max)
        energy_curve = [(int(t), float(e)) for t, e in zip(times_ms[:len(rms_db)], rms_db)]
        
        # Statistics
        valid_f0 = [f for _, f in f0_curve]
        f0_stats = {
            "mean": float(np.mean(valid_f0)) if valid_f0 else 0,
            "std": float(np.std(valid_f0)) if valid_f0 else 0,
            "range": float(np.max(valid_f0) - np.min(valid_f0)) if valid_f0 else 0
        }
        
        energy_values = [e for _, e in energy_curve]
        energy_stats = {
            "mean": float(np.mean(energy_values)) if energy_values else 0,
            "std": float(np.std(energy_values)) if energy_values else 0,
            "range": float(np.max(energy_values) - np.min(energy_values)) if energy_values else 0
        }
        
        # Detect monotone segments (F0 std < 25 Hz over 5 second windows)
        monotone_segments = _detect_monotone_segments(f0_curve, window_ms=5000, threshold_hz=25)
        
        # Calculate emotion curve (normalized 0-100)
        emotion_curve = _calculate_emotion_curve(f0_curve, energy_curve)
        
        return {
            "duration_sec": duration_sec,
            "f0_curve": f0_curve,
            "energy_curve": energy_curve,
            "f0_stats": f0_stats,
            "energy_stats": energy_stats,
            "monotone_segments": monotone_segments,
            "emotion_curve": emotion_curve
        }
        
    except Exception as e:
        return {"error": str(e)}

def _detect_monotone_segments(f0_curve: List[Tuple], window_ms: int = 5000, threshold_hz: float = 25) -> List[Tuple]:
    """
    Detect segments where F0 variation is too low (monotone speaking)
    """
    if not f0_curve:
        return []
    
    segments = []
    window_start = 0
    window_f0 = []
    
    for time_ms, f0 in f0_curve:
        # Check if we're still in the current window
        if time_ms - window_start > window_ms:
            # Analyze current window
            if len(window_f0) >= 5:  # Need at least 5 samples
                std = np.std(window_f0)
                if std < threshold_hz:
                    segments.append((window_start, time_ms))
            
            # Start new window
            window_start = time_ms
            window_f0 = []
        
        window_f0.append(f0)
    
    return segments

def _calculate_emotion_curve(f0_curve: List[Tuple], energy_curve: List[Tuple]) -> List[Tuple]:
    """
    Calculate emotion energy curve (0-100) based on F0 and energy variations
    
    Formula: E(t) = w1 * norm(F0_std) + w2 * norm(Energy)
    """
    if not f0_curve or not energy_curve:
        return []
    
    # Normalize F0 values
    f0_values = [f for _, f in f0_curve]
    f0_min, f0_max = min(f0_values), max(f0_values)
    f0_range = f0_max - f0_min if f0_max > f0_min else 1
    
    # Normalize energy values
    energy_values = [e for _, e in energy_curve]
    energy_min, energy_max = min(energy_values), max(energy_values)
    energy_range = energy_max - energy_min if energy_max > energy_min else 1
    
    # Create time-aligned emotion curve
    emotion_curve = []
    
    # Use energy timestamps as base (typically more frequent)
    f0_dict = dict(f0_curve)
    
    for time_ms, energy in energy_curve:
        # Find nearest F0 value
        f0 = f0_dict.get(time_ms, f0_values[0] if f0_values else 0)
        if f0 == 0:
            # Find closest F0
            closest_time = min(f0_dict.keys(), key=lambda t: abs(t - time_ms), default=None)
            if closest_time is not None:
                f0 = f0_dict[closest_time]
        
        # Normalize
        f0_norm = (f0 - f0_min) / f0_range * 100 if f0 > 0 else 0
        energy_norm = (energy - energy_min) / energy_range * 100
        
        # Weighted combination (w1=0.4, w2=0.6)
        emotion_value = 0.4 * f0_norm + 0.6 * energy_norm
        
        emotion_curve.append((time_ms, round(emotion_value, 1)))
    
    return emotion_curve

async def extract_keyframes(video_path: str, output_dir: str, 
                           intervals: List[int] = None, 
                           adaptive: bool = True,
                           duration_sec: float = None) -> List[Dict]:
    """
    Extract keyframes from video
    
    Args:
        video_path: Path to video file
        output_dir: Directory to save frames
        intervals: List of timestamps (ms) to extract, or None for adaptive
        adaptive: Use adaptive interval strategy based on duration
        duration_sec: Video duration in seconds
    
    Returns:
        [{"time_ms": 10000, "path": "frame_0001.jpg"}, ...]
    """
    import subprocess
    
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    
    # Determine extraction times
    if intervals is None and adaptive and duration_sec:
        intervals = _get_adaptive_intervals(duration_sec)
    elif intervals is None:
        # Default: every 30 seconds, starting at 10s
        intervals = list(range(10000, int((duration_sec or 300) * 1000), 30000))
    
    results = []
    
    for i, time_ms in enumerate(intervals):
        output_path = Path(output_dir) / f"frame_{i:04d}.jpg"
        time_sec = time_ms / 1000
        
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(time_sec),
            "-i", video_path,
            "-vframes", "1",
            "-q:v", "2",
            str(output_path)
        ]
        
        try:
            print(f"[FFmpeg] Executing: {' '.join(cmd)}")
            
            # Run in thread to avoid blocking loop
            def run_ffmpeg():
                return subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding='utf-8',
                    errors='replace'
                )

            result = await asyncio.to_thread(run_ffmpeg)
            
            if result.returncode == 0 and output_path.exists():
                results.append({
                    "time_ms": time_ms,
                    "path": str(output_path)
                })
            else:
                output = result.stderr + "\n" + result.stdout
                print(f"Frame extraction failed at {time_ms}ms (code {result.returncode}): {output[:500]}")
        except Exception as e:
            print(f"Frame extraction failed at {time_ms}ms: {e}")
        except Exception as e:
            print(f"Frame extraction failed at {time_ms}ms: {e}")
    
    return results

def _get_adaptive_intervals(duration_sec: float, max_frames: int = 15) -> List[int]:
    """
    Get adaptive keyframe intervals based on video duration
    
    策略:
    - 前 2 分钟：每 30 秒截一帧
    - 2-5 分钟：每 40 秒截一帧
    - 5-10 分钟：每 60 秒截一帧
    - >10 分钟：每 120 秒截一帧
    - 最大帧数限制：max_frames（默认15帧，避免超长视频卡住分析）
    - 超过 20 分钟的视频：智能抽样，保证首尾+均匀分布
    """
    duration_ms = int(duration_sec * 1000)
    
    # 对于超长视频（>20分钟），直接使用均匀抽样
    if duration_sec > 1200:  # 20 minutes
        print(f"[Keyframes] Long video detected ({duration_sec:.0f}s), using uniform sampling")
        # 使用均匀分布的帧，确保覆盖首尾
        step = duration_ms // (max_frames + 1)
        intervals = [step * (i + 1) for i in range(max_frames)]
        # 确保第一帧不早于10秒
        intervals = [max(10000, t) for t in intervals]
        # 确保最后一帧不晚于结束前10秒
        intervals = [min(duration_ms - 10000, t) for t in intervals]
        return sorted(set(intervals))[:max_frames]
    
    intervals = []
    current_ms = 10000  # Start at 10 seconds
    
    while current_ms < duration_ms and len(intervals) < max_frames:
        intervals.append(current_ms)
        
        if current_ms < 120000:  # First 2 minutes
            current_ms += 30000
        elif current_ms < 300000:  # 2-5 minutes
            current_ms += 40000
        elif current_ms < 600000:  # 5-10 minutes
            current_ms += 60000
        else:  # >10 minutes
            current_ms += 120000
    
    # Ensure at least 3 frames for short videos
    if len(intervals) < 3 and duration_ms > 10000:
        step = max(10000, (duration_ms - 10000) // 3)
        intervals = [10000 + i * step for i in range(3) if 10000 + i * step < duration_ms]
    
    print(f"[Keyframes] Duration: {duration_sec:.0f}s, extracted {len(intervals)} frames")
    return intervals[:max_frames]
