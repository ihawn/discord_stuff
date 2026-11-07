import { readFile } from 'node:fs/promises';
import type { Segment } from './format.js';

export function transcriberClient(baseUrl: string): (wavPath: string) => Promise<Segment[]> {
  return async (wavPath) => {
    const form = new FormData();
    form.append('file', new Blob([await readFile(wavPath)], { type: 'audio/wav' }), 'audio.wav');
    const res = await fetch(`${baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(3 * 3600 * 1000),
    });
    if (!res.ok) throw new Error(`transcriber returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { segments: Segment[] };
    return body.segments;
  };
}
