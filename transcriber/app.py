"""Whisper transcription service. POST /transcribe with a 16 kHz mono WAV, get timed segments.

The model is loaded on first use and dropped after IDLE_UNLOAD_SECONDS without work, because this
runs on a shared box and the model holds a couple of GB of RAM.
"""
import gc
import os
import tempfile
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
THREADS = int(os.environ.get("WHISPER_THREADS", "4"))
IDLE_UNLOAD_SECONDS = int(os.environ.get("IDLE_UNLOAD_SECONDS", "300"))
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

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


def shape_segments(segments):
    """Plain dicts with trimmed text; blank segments dropped."""
    out = []
    for s in segments:
        text = s.text.strip()
        if text:
            out.append({"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": text})
    return out


def _unload_when_idle():
    global _model
    while True:
        time.sleep(30)
        with _lock:
            if _model is not None and time.time() - _last_used > IDLE_UNLOAD_SECONDS:
                _model = None
                gc.collect()


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
        with _lock:
            try:
                segments, info = get_model().transcribe(
                    tmp.name, language=LANGUAGE, vad_filter=True, beam_size=5,
                    condition_on_previous_text=False,
                )
                result = shape_segments(segments)  # the generator does the work; consume inside the lock
            finally:
                _last_used = time.time()
    return {"language": info.language, "segments": result}
