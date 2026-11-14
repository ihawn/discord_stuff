import { ChannelType, Client, Events, GatewayIntentBits, type Guild, type VoiceBasedChannel } from 'discord.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { PipelineDeps, isFinished, processSession, pruneOld } from './pipeline.js';
import { RecordingSession } from './session.js';
import { transcriberClient } from './transcriber-client.js';

const cfg = loadConfig();
process.umask(0o077); // recordings are private: owner-only files, also for ffmpeg children
const sessionsDir = path.join(cfg.dataDir, 'sessions');
const activeMarker = path.join(cfg.dataDir, 'ACTIVE');
mkdirSync(sessionsDir, { recursive: true });
rmSync(activeMarker, { force: true }); // a marker left by a crash must not block updates

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

let session: RecordingSession | undefined;
let starting = false;
let emptySince: NodeJS.Timeout | undefined;
let maxTimer: NodeJS.Timeout | undefined;
let queue: Promise<void> = Promise.resolve();

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function deps(): Promise<PipelineDeps> {
  const transcribe = transcriberClient(cfg.transcriberUrl);
  return {
    transcribe,
    maxUploadBytes: cfg.maxUploadBytes,
    timezone: cfg.timezone,
    minSessionMs: cfg.minSessionMs,
    async post({ content, files }) {
      const channel = await client.channels.fetch(cfg.transcriptChannelId);
      if (!channel?.isTextBased() || !('send' in channel)) throw new Error('transcript channel is not a text channel');
      await channel.send({ content, files: files.map((f) => ({ attachment: f.path, name: f.name })), allowedMentions: { parse: [] } });
    },
  };
}

/** Process sessions one at a time, retrying with a delay. Unfinished work is also picked up on restart. */
function enqueue(dir: string): void {
  queue = queue.then(async () => {
    for (let attempt = 1; attempt <= 3 && !isFinished(dir); attempt++) {
      try {
        log(`processing ${path.basename(dir)} (attempt ${attempt})`);
        const outcome = await processSession(dir, await deps());
        log(`${path.basename(dir)}: ${outcome}`);
        pruneOld(sessionsDir, cfg.retentionDays);
        return;
      } catch (err) {
        log(`processing failed: ${err instanceof Error ? err.message : err}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5 * 60_000));
      }
    }
    if (!isFinished(dir)) {
      log(`giving up on ${path.basename(dir)}; it will be retried on the next restart`);
    }
  });
}

function recoverUnfinished(): void {
  for (const name of readdirSync(sessionsDir).sort()) {
    const dir = path.join(sessionsDir, name);
    const metaPath = path.join(dir, 'session.json');
    if (!existsSync(metaPath) || isFinished(dir)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (!meta.endedAt) {
      const newest = Math.max(meta.startedAt, ...readdirSync(dir).map((f) => statSync(path.join(dir, f)).mtimeMs));
      meta.endedAt = Math.floor(newest);
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }
    enqueue(dir);
  }
}

const watched = (c: VoiceBasedChannel): boolean =>
  cfg.watchChannelIds.length === 0 || cfg.watchChannelIds.includes(c.id);
const humans = (c: VoiceBasedChannel): number => c.members.filter((m) => !m.user.bot).size;

function voiceChannels(guild: Guild): VoiceBasedChannel[] {
  return guild.channels.cache
    .filter((c): c is VoiceBasedChannel => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
    .map((c) => c);
}

async function startSession(channel: VoiceBasedChannel): Promise<void> {
  starting = true;
  try {
    const s = new RecordingSession(channel, sessionsDir);
    await s.start();
    session = s;
    writeFileSync(activeMarker, s.dir);
    maxTimer = setTimeout(() => void endSession('max duration'), cfg.maxSessionMs);
    log(`recording #${channel.name}`);
    const notice = '🔴 This call is being recorded and transcribed. Leave the channel if you do not want to be included.';
    await channel.send(notice).catch(() => log('could not post the recording notice in the voice channel'));
  } catch (err) {
    log(`could not join #${channel.name}: ${err instanceof Error ? err.message : err}`);
  } finally {
    starting = false;
  }
}

async function endSession(reason: string): Promise<void> {
  const s = session;
  if (!s) return;
  session = undefined;
  clearTimeout(emptySince);
  clearTimeout(maxTimer);
  emptySince = maxTimer = undefined;
  s.stop();
  rmSync(activeMarker, { force: true });
  log(`stopped #${s.channel.name} (${reason})`);
  enqueue(s.dir);
  reconcile(s.channel.guild);
}

function reconcile(guild: Guild): void {
  if (cfg.guildId && guild.id !== cfg.guildId) return;
  if (starting) return;
  if (session) {
    if (session.channel.guild.id !== guild.id) return;
    const here = humans(session.channel);
    if (here === 0 && !emptySince) {
      emptySince = setTimeout(() => void endSession('channel empty'), cfg.leaveGraceMs);
    } else if (here > 0 && emptySince) {
      clearTimeout(emptySince);
      emptySince = undefined;
    }
    return;
  }
  const next = voiceChannels(guild).find((c) => watched(c) && humans(c) > 0);
  if (next) void startSession(next);
}

client.on(Events.VoiceStateUpdate, (oldState, newState) => reconcile(newState.guild ?? oldState.guild));

client.once(Events.ClientReady, (c) => {
  log(`logged in as ${c.user.tag}`);
  recoverUnfinished();
  pruneOld(sessionsDir, cfg.retentionDays);
  for (const guild of c.guilds.cache.values()) reconcile(guild);
});

const shutdown = async () => {
  await endSession('shutdown');
  await queue;
  client.destroy();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await client.login(cfg.token);
