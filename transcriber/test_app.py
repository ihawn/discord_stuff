import io
import wave
from types import SimpleNamespace as NS

from fastapi.testclient import TestClient

import app as service


def make_wav(seconds, rate=16000, channels=1):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * channels * int(rate * seconds))
    return buf.getvalue()


def test_shape_segments_trims_and_drops_blanks():
    segs = [NS(start=1.234, end=2.0, text="  hi "), NS(start=3, end=4, text="   ")]
    assert service.shape_segments(segs) == [{"start": 1.23, "end": 2.0, "text": "hi"}]


def test_transcribe_chunks_long_audio_and_offsets_timestamps(monkeypatch):
    seen = []

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            assert kwargs["vad_filter"] is True
            seen.append(len(audio))
            return iter([NS(start=0.5, end=1.5, text=" test ")]), NS(language="en")

    monkeypatch.setattr(service, "get_model", lambda: FakeModel())
    monkeypatch.setattr(service, "CHUNK_SECONDS", 2)
    wav = make_wav(5)
    r = TestClient(service.app).post("/transcribe", files={"file": ("a.wav", wav, "audio/wav")})
    assert r.status_code == 200
    assert seen == [32000, 32000, 16000]
    assert r.json() == {"language": "en", "segments": [
        {"start": 0.5, "end": 1.5, "text": "test"},
        {"start": 2.5, "end": 3.5, "text": "test"},
        {"start": 4.5, "end": 5.5, "text": "test"},
    ]}


def test_transcribe_rejects_bad_audio(monkeypatch):
    monkeypatch.setattr(service, "get_model", lambda: None)
    client = TestClient(service.app)
    for body in (b"RIFF....", make_wav(1, rate=48000), make_wav(1, channels=2)):
        assert client.post("/transcribe", files={"file": ("a.wav", body, "audio/wav")}).status_code == 400


def test_health():
    assert TestClient(service.app).get("/health").json()["ok"] is True
