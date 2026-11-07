import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { cleanName, safeDirName } from './format.js';

/** 48 kHz mono signed 16-bit PCM. */
export const SAMPLE_RATE = 48000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

export interface SessionMeta {
  guildId: string;
  channelId: string;
  channelName: string;
  startedAt: number;
  endedAt?: number;
  users: Record<string, string>;
}

interface Track {
  fd: number;
  pos: number;
  active: boolean;
}

/**
 * Records every speaker in one voice channel into a sparse per-user PCM file.
 * Each utterance is written at its offset from the session start, so the gaps are
 * holes that read back as silence and every track shares one timeline.
 */
export class RecordingSession {
  readonly dir: string;
  readonly meta: SessionMeta;
  private connection?: VoiceConnection;
  private tracks = new Map<string, Track>();
  private stopped = false;

  constructor(readonly channel: VoiceBasedChannel, sessionsDir: string) {
    const startedAt = Date.now();
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(sessionsDir, `${stamp}_${safeDirName(channel.name)}`);
    this.meta = { guildId: channel.guild.id, channelId: channel.id, channelName: channel.name, startedAt, users: {} };
  }

  async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.writeMeta();
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      this.connection.destroy();
      throw err;
    }
    this.connection.receiver.speaking.on('start', (userId) => this.onSpeaking(userId));
  }

  private onSpeaking(userId: string): void {
    if (this.stopped || !this.connection) return;
    let track = this.tracks.get(userId);
    if (!track) {
      track = { fd: openSync(path.join(this.dir, `${userId}.pcm`), 'w'), pos: 0, active: false };
      this.tracks.set(userId, track);
      const member = this.channel.guild.members.cache.get(userId);
      this.meta.users[userId] = cleanName(member?.displayName ?? userId);
      this.writeMeta();
    }
    if (track.active) return;
    track.active = true;
    const t = track;
    t.pos = Math.max(t.pos, Math.floor(((Date.now() - this.meta.startedAt) * BYTES_PER_MS) / 2) * 2);

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: 1, frameSize: 960 });
    const done = () => { t.active = false; };
    opus.on('error', done).on('end', done);
    decoder.on('error', () => {}); // a corrupt packet loses one frame, not the session
    decoder.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      writeSync(t.fd, chunk, 0, chunk.length, t.pos);
      t.pos += chunk.length;
    });
    opus.pipe(decoder);
  }

  stop(): SessionMeta {
    if (!this.stopped) {
      this.stopped = true;
      this.connection?.destroy();
      for (const t of this.tracks.values()) closeSync(t.fd);
      this.meta.endedAt = Date.now();
      this.writeMeta();
    }
    return this.meta;
  }

  private writeMeta(): void {
    writeFileSync(path.join(this.dir, 'session.json'), JSON.stringify(this.meta, null, 2));
  }
}
