import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isFinished, processSession, pruneOld, type PipelineDeps } from './pipeline.js';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function sessionDir(seconds: number, users: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sess-'));
  const startedAt = Date.now() - seconds * 1000;
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ guildId: 'g', channelId: 'c', channelName: 'Lounge', startedAt, endedAt: startedAt + seconds * 1000, users }));
  for (const id of Object.keys(users)) {
    // 3 seconds of a 440 Hz tone as 48 kHz mono s16le
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000', '-f', 's16le', '-ac', '1', path.join(dir, `${id}.pcm`)]);
  }
  return dir;
}

const fakeDeps = (posted: unknown[], over: Partial<PipelineDeps> = {}): PipelineDeps => ({
  transcribe: async () => [{ start: 1.5, end: 2, text: ' hello there ' }],
  post: async (m) => { posted.push(m); },
  maxUploadBytes: 9_000_000,
  timezone: 'America/Chicago',
  minSessionMs: 20_000,
  ...over,
});

test('posts transcript and audio, keeps flac, drops pcm', { skip: !hasFfmpeg }, async () => {
  const dir = sessionDir(60, { u1: 'isaac', u2: 'silas' });
  const posted: any[] = [];
  assert.equal(await processSession(dir, fakeDeps(posted)), 'posted');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].files.map((f: any) => f.name), ['transcript.txt', 'audio.ogg']);
  assert.match(posted[0].content, /Lounge/);
  assert.match(posted[0].content, /isaac, silas/);
  const transcript = readFileSync(path.join(dir, 'transcript.txt'), 'utf8');
  assert.match(transcript, /\[00:01\] isaac: hello there/);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.pcm')), []);
  assert.ok(existsSync(path.join(dir, 'u1.flac')));
  assert.ok(isFinished(dir));
});

test('skips short sessions without posting', { skip: !hasFfmpeg }, async () => {
  const dir = sessionDir(5, { u1: 'isaac' });
  const posted: any[] = [];
  assert.equal(await processSession(dir, fakeDeps(posted)), 'skipped');
  assert.equal(posted.length, 0);
  assert.ok(isFinished(dir));
});

test('skips sessions with no speech', { skip: !hasFfmpeg }, async () => {
  const dir = sessionDir(60, { u1: 'isaac' });
  const posted: any[] = [];
  assert.equal(await processSession(dir, fakeDeps(posted, { transcribe: async () => [] })), 'skipped');
  assert.equal(posted.length, 0);
});

test('a failed post leaves the session unfinished so it can be retried', { skip: !hasFfmpeg }, async () => {
  const dir = sessionDir(60, { u1: 'isaac' });
  await assert.rejects(processSession(dir, fakeDeps([], { post: async () => { throw new Error('discord down'); } })), /discord down/);
  assert.equal(isFinished(dir), false);
  assert.ok(existsSync(path.join(dir, 'u1.pcm')));
});

test('long sessions skip the audio attachment but still post the transcript', { skip: !hasFfmpeg }, async () => {
  const dir = sessionDir(3 * 3600, { u1: 'isaac' });
  const posted: any[] = [];
  await processSession(dir, fakeDeps(posted));
  assert.deepEqual(posted[0].files.map((f: any) => f.name), ['transcript.txt']);
  assert.match(posted[0].content, /too long to attach/);
});

test('pruneOld removes only old finished sessions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'prune-'));
  const old = path.join(root, 'old'); const fresh = path.join(root, 'fresh'); const open = path.join(root, 'open');
  for (const d of [old, fresh, open]) mkdirSync(d);
  writeFileSync(path.join(old, 'done'), 'x'); writeFileSync(path.join(fresh, 'done'), 'x');
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(path.join(old, 'done'), longAgo, longAgo);
  utimesSync(open, longAgo, longAgo);
  assert.deepEqual(pruneOld(root, 14), ['old']);
  assert.ok(existsSync(fresh) && existsSync(open));
});
