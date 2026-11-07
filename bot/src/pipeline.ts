import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Segment, chooseBitrateKbps, cleanName, fmtDuration, mergeSegments } from './format.js';
import type { SessionMeta } from './session.js';

const run = promisify(execFile);
const MIN_TRACK_BYTES = 96 * 1000; // under one second of audio

export interface PipelineDeps {
  transcribe(wavPath: string): Promise<Segment[]>;
  post(message: { content: string; files: { path: string; name: string }[] }): Promise<void>;
  maxUploadBytes: number;
  timezone: string;
  minSessionMs: number;
}

export type Outcome = 'posted' | 'skipped';

const readMeta = (dir: string): SessionMeta => JSON.parse(readFileSync(path.join(dir, 'session.json'), 'utf8'));

export const isFinished = (dir: string): boolean => existsSync(path.join(dir, 'done'));

/** Transcribe and post one finished session. Throws if anything fails so the caller can retry. */
export async function processSession(dir: string, deps: PipelineDeps): Promise<Outcome> {
  const meta = readMeta(dir);
  const endedAt = meta.endedAt ?? Date.now();
  const durationMs = endedAt - meta.startedAt;
  const pcmFiles = readdirSync(dir).filter((f) => f.endsWith('.pcm'));
  const usable = pcmFiles.filter((f) => statSync(path.join(dir, f)).size >= MIN_TRACK_BYTES);

  if (durationMs < deps.minSessionMs || usable.length === 0) {
    writeFileSync(path.join(dir, 'done'), 'skipped: too short or silent\n');
    return 'skipped';
  }

  const perSpeaker: Record<string, Segment[]> = {};
  for (const file of usable) {
    const id = file.replace(/\.pcm$/, '');
    const name = cleanName(meta.users[id] ?? id);
    const pcm = path.join(dir, file);
    const wav = path.join(dir, `${id}.16k.wav`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', pcm, '-ar', '16000', '-ac', '1', wav]);
    perSpeaker[name] = [...(perSpeaker[name] ?? []), ...(await deps.transcribe(wav))];
    rmSync(wav, { force: true });
  }

  const lines = mergeSegments(perSpeaker);
  if (lines.length === 0) {
    writeFileSync(path.join(dir, 'done'), 'skipped: no speech detected\n');
    return 'skipped';
  }

  const transcriptPath = path.join(dir, 'transcript.txt');
  writeFileSync(transcriptPath, lines.join('\n') + '\n');

  const files = [{ path: transcriptPath, name: 'transcript.txt' }];
  const kbps = chooseBitrateKbps(deps.maxUploadBytes, durationMs);
  let audioNote = '';
  if (kbps === null) {
    audioNote = '\nAudio is too long to attach; the tracks are kept on the server.';
  } else {
    const mixPath = path.join(dir, 'audio.ogg');
    const inputs = usable.flatMap((f) => ['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', path.join(dir, f)]);
    const filter = usable.length > 1 ? `amix=inputs=${usable.length}:duration=longest:normalize=0` : 'anull';
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-ac', '1', '-c:a', 'libopus', '-b:a', `${kbps}k`, mixPath]);
    files.push({ path: mixPath, name: 'audio.ogg' });
  }

  const when = new Date(meta.startedAt).toLocaleString('en-US', {
    timeZone: deps.timezone, dateStyle: 'medium', timeStyle: 'short',
  });
  const speakers = Object.keys(perSpeaker).sort().join(', ');
  const content = `**${meta.channelName}** · ${when} · ${fmtDuration(durationMs)} · ${speakers}${audioNote}`.slice(0, 1900);
  await deps.post({ content, files });

  // Keep per-user FLAC for the retention window, then drop the large raw PCM.
  for (const file of usable) {
    const flac = path.join(dir, file.replace(/\.pcm$/, '.flac'));
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', path.join(dir, file), flac]);
  }
  for (const file of pcmFiles) rmSync(path.join(dir, file), { force: true });
  writeFileSync(path.join(dir, 'done'), 'posted\n');
  return 'posted';
}

/** Delete finished sessions older than the retention window. */
export function pruneOld(sessionsDir: string, retentionDays: number, now = Date.now()): string[] {
  if (!existsSync(sessionsDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(sessionsDir)) {
    const dir = path.join(sessionsDir, name);
    if (!isFinished(dir)) continue;
    if (now - statSync(path.join(dir, 'done')).mtimeMs > retentionDays * 86_400_000) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
