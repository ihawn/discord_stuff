import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { Segment } from './format.js';

/** Multipart body that streams the WAV from disk; FormData would hold a whole track in RAM. */
function multipartBody(wavPath: string, boundary: string): Readable {
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  return Readable.from((async function* () {
    yield Buffer.from(head);
    yield* createReadStream(wavPath);
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  })());
}

/** POSTs a WAV to the transcriber. Uses node:http because fetch gives up after 5 minutes without response headers. */
export function transcriberClient(baseUrl: string, timeoutMs = 3 * 3600 * 1000): (wavPath: string) => Promise<Segment[]> {
  return async (wavPath) => {
    const boundary = `rico-${randomUUID()}`;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(`${baseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        signal: AbortSignal.timeout(timeoutMs),
      }, resolve);
      req.on('error', reject);
      multipartBody(wavPath, boundary).on('error', (err) => req.destroy(err)).pipe(req);
    });
    res.setEncoding('utf8');
    let text = '';
    for await (const chunk of res) text += chunk;
    if (res.statusCode !== 200) throw new Error(`transcriber returned ${res.statusCode}: ${text.slice(0, 200)}`);
    return (JSON.parse(text) as { segments: Segment[] }).segments;
  };
}
