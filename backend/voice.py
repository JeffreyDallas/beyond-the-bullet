"""Optional local speech adapters.

The adapters are deliberately lazy. Importing the API, running unit tests, or
using text-only mode never downloads model weights or initializes a model.
"""

import io
import os
import wave
from dataclasses import dataclass
from typing import Any

try:
    from faster_whisper import WhisperModel
except ImportError:  # Optional voice dependency.
    WhisperModel = None

try:
    from kokoro import KPipeline
except ImportError:  # Optional voice dependency.
    KPipeline = None


class VoiceNotConfigured(RuntimeError):
    """Raised when local voice mode is not explicitly configured."""


@dataclass(frozen=True)
class VoiceStatus:
    enabled: bool
    stt_available: bool
    tts_available: bool
    stt_loaded: bool
    tts_loaded: bool
    model: str
    voice: str


class LocalSpeechService:
    """faster-whisper and Kokoro behind an explicit opt-in switch."""

    def __init__(self) -> None:
        self.enabled = os.getenv("LOCAL_VOICE_MODE", "false").lower() == "true"
        self.whisper_model_name = os.getenv("WHISPER_MODEL", "small.en")
        self.whisper_model_path = os.getenv("WHISPER_MODEL_PATH", "")
        self.whisper_device = os.getenv("WHISPER_DEVICE", "cpu")
        self.whisper_compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        self.kokoro_voice = os.getenv("KOKORO_VOICE", "af_heart")
        self.kokoro_lang_code = os.getenv("KOKORO_LANG_CODE", "a")
        self._whisper: Any = None
        self._kokoro: Any = None

    def status(self) -> VoiceStatus:
        return VoiceStatus(
            enabled=self.enabled,
            stt_available=WhisperModel is not None,
            tts_available=KPipeline is not None,
            stt_loaded=self._whisper is not None,
            tts_loaded=self._kokoro is not None,
            model=self.whisper_model_name,
            voice=self.kokoro_voice,
        )

    def _require(self) -> None:
        if not self.enabled:
            raise VoiceNotConfigured("Set LOCAL_VOICE_MODE=true to enable local speech models")
        if WhisperModel is None or KPipeline is None:
            raise VoiceNotConfigured("Install the optional voice dependencies from requirements-voice.txt")

    def _load_whisper(self) -> Any:
        self._require()
        if self._whisper is None:
            model = self.whisper_model_path or self.whisper_model_name
            self._whisper = WhisperModel(model, device=self.whisper_device, compute_type=self.whisper_compute_type)
        return self._whisper

    def _load_kokoro(self) -> Any:
        self._require()
        if self._kokoro is None:
            self._kokoro = KPipeline(lang_code=self.kokoro_lang_code)
        return self._kokoro

    def transcribe(self, audio: bytes) -> dict[str, Any]:
        """Transcribe an audio payload and return text plus segment timings."""
        model = self._load_whisper()
        segments, info = model.transcribe(io.BytesIO(audio), vad_filter=True)
        transcript_segments = [
            {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in segments
        ]
        return {
            "text": " ".join(item["text"] for item in transcript_segments).strip(),
            "language": getattr(info, "language", None),
            "segments": transcript_segments,
        }

    def synthesize(self, text: str) -> bytes:
        """Render Kokoro output as a PCM WAV payload suitable for browser audio."""
        pipeline = self._load_kokoro()
        chunks: list[bytes] = []
        sample_rate = 24_000
        for _, _, audio in pipeline(text, voice=self.kokoro_voice, speed=1):
            sample_rate = int(getattr(audio, "sample_rate", sample_rate))
            chunks.append((audio.clip(-1, 1) * 32767).astype("int16").tobytes())
        if not chunks:
            raise ValueError("Kokoro returned no audio")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(b"".join(chunks))
        return output.getvalue()
