export interface Segment { start: number; end: number; text: string }

export function fmtClock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

/** Time-ordered transcript lines from per-speaker segments (seconds from session start). */
export function mergeSegments(perSpeaker: Record<string, Segment[]>): string[] {
  const rows: { start: number; name: string; text: string }[] = [];
  for (const [name, segs] of Object.entries(perSpeaker)) {
    for (const seg of segs) {
      const text = seg.text.trim();
      if (text) rows.push({ start: seg.start, name, text });
    }
  }
  rows.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  return rows.map((r) => `[${fmtClock(r.start)}] ${r.name}: ${r.text}`);
}

/** Opus bitrate (kbps) that fits the session into maxBytes, capped at 24; null if it would be unintelligible. */
export function chooseBitrateKbps(maxBytes: number, durationMs: number): number | null {
  const kbps = Math.min(24, Math.floor((maxBytes * 8) / (durationMs / 1000) / 1000));
  return kbps >= 12 ? kbps : null;
}

/** Display-safe speaker name: no control characters, no markdown, bounded length. */
export function cleanName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[*_`~|>\\]/g, '').trim();
  return (cleaned || 'unknown').slice(0, 32);
}

export function safeDirName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
}
