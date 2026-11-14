import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { transcriberClient } from './transcriber-client.js';

test('transcriberClient streams the WAV as a valid multipart upload', async () => {
  const wav = path.join(mkdtempSync(path.join(tmpdir(), 'tc-')), 'a.wav');
  const audio = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
  writeFileSync(wav, audio);
  let received: Buffer | undefined;
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const form = await new Response(Buffer.concat(parts), { headers: { 'content-type': req.headers['content-type']! } }).formData();
    received = Buffer.from(await (form.get('file') as File).arrayBuffer());
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ segments: [{ start: 1, end: 2, text: 'hi' }] }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as { port: number }).port;
    const segments = await transcriberClient(`http://127.0.0.1:${port}`)(wav);
    assert.deepEqual(segments, [{ start: 1, end: 2, text: 'hi' }]);
    assert.ok(received?.equals(audio));
  } finally {
    server.close();
  }
});

test('transcriberClient throws on a non-200 reply', async () => {
  const wav = path.join(mkdtempSync(path.join(tmpdir(), 'tc-')), 'a.wav');
  writeFileSync(wav, 'x');
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 400; res.end('bad wav'); }); });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as { port: number }).port;
    await assert.rejects(transcriberClient(`http://127.0.0.1:${port}`)(wav), /400: bad wav/);
  } finally {
    server.close();
  }
});
