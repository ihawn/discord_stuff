"""Whisper transcription service. POST /transcribe with a 16 kHz mono WAV, get timed segments.

The model is loaded on first use and dropped after IDLE_UNLOAD_SECONDS without work, because this
runs on a shared box and the model holds a couple of GB of RAM.
"""
import ctypes
import gc
import os
import tempfile
import threading
import time
import wave
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
THREADS = int(os.environ.get("WHISPER_THREADS", "4"))
IDLE_UNLOAD_SECONDS = int(os.environ.get("IDLE_UNLOAD_SECONDS", "300"))
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
CHUNK_SECONDS = 600  # whisper sees 10 minutes at a time, so a long call never sits in RAM whole
SAMPLE_RATE = 16000

_lock = threading.Lock()  # one transcription at a time keeps CPU and RAM bounded
_model = None
_last_used = 0.0


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=THREADS,
                              download_root=os.environ.get("MODEL_DIR", "/models"))
    return _model


def shape_segments(segments, offset=0.0):
    """Plain dicts with trimmed text, shifted by offset seconds; blank segments dropped."""
    out = []
    for s in segments:
        text = s.text.strip()
        if text:
            out.append({"start": round(offset + s.start, 2), "end": round(offset + s.end, 2), "text": text})
    return out


def wav_chunks(path):
    """Yield (offset seconds, float32 samples) for a 16 kHz mono 16-bit WAV, one chunk at a time."""
    try:
        w = wave.open(path, "rb")
    except (wave.Error, EOFError) as e:
        raise HTTPException(400, f"not a WAV file: {e}")
    with w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise HTTPException(400, "expected 16 kHz mono 16-bit WAV")
        offset = 0.0
        while data := w.readframes(SAMPLE_RATE * CHUNK_SECONDS):
            audio = np.frombuffer(data, np.int16).astype(np.float32) / 32768.0
            yield offset, audio
            offset += len(audio) / SAMPLE_RATE


def _unload_when_idle():
    global _model
    while True:
        time.sleep(30)
        with _lock:
            if _model is not None and time.time() - _last_used > IDLE_UNLOAD_SECONDS:
                _model = None
                gc.collect()
                ctypes.CDLL("libc.so.6").malloc_trim(0)  # else glibc keeps the freed model and the next load hits the memory cap


@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=_unload_when_idle, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/transcribe")
def transcribe(file: UploadFile = File(...)):
    global _last_used
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        size = 0
        while chunk := file.file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "audio too large")
            tmp.write(chunk)
        tmp.flush()
        language, result = LANGUAGE, []
        with _lock:
            try:
                for offset, audio in wav_chunks(tmp.name):
                    segments, info = get_model().transcribe(
                        audio, language=LANGUAGE, vad_filter=True, beam_size=5,
                        condition_on_previous_text=False,
                    )
                    language = info.language
                    result += shape_segments(segments, offset)  # the generator does the work; consume inside the lock
            finally:
                _last_used = time.time()
    return {"language": language, "segments": result}
