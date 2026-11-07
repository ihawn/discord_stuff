from types import SimpleNamespace as NS

from fastapi.testclient import TestClient

import app as service


def test_shape_segments_trims_and_drops_blanks():
    segs = [NS(start=1.234, end=2.0, text="  hi "), NS(start=3, end=4, text="   ")]
    assert service.shape_segments(segs) == [{"start": 1.23, "end": 2.0, "text": "hi"}]


def test_transcribe_returns_segments(monkeypatch):
    class FakeModel:
        def transcribe(self, path, **kwargs):
            assert kwargs["vad_filter"] is True
            return iter([NS(start=0.5, end=1.5, text=" test ")]), NS(language="en")

    monkeypatch.setattr(service, "get_model", lambda: FakeModel())
    r = TestClient(service.app).post("/transcribe", files={"file": ("a.wav", b"RIFF....", "audio/wav")})
    assert r.status_code == 200
    assert r.json() == {"language": "en", "segments": [{"start": 0.5, "end": 1.5, "text": "test"}]}


def test_health():
    assert TestClient(service.app).get("/health").json()["ok"] is True
