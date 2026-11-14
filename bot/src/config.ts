const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
};
const list = (name: string): string[] =>
  (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export interface Config {
  token: string;
  transcriptChannelId: string;
  guildId: string;
  watchChannelIds: string[];
  transcriberUrl: string;
  dataDir: string;
  leaveGraceMs: number;
  minSessionMs: number;
  maxSessionMs: number;
  maxUploadBytes: number;
  retentionDays: number;
  timezone: string;
}

export function loadConfig(): Config {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  return {
    token: need('DISCORD_TOKEN'),
    transcriptChannelId: need('TRANSCRIPT_CHANNEL_ID'),
    guildId: process.env.GUILD_ID ?? '',
    watchChannelIds: list('WATCH_CHANNEL_IDS'),
    transcriberUrl: process.env.TRANSCRIBER_URL ?? 'http://transcriber:8000',
    dataDir: process.env.DATA_DIR ?? '/data',
    leaveGraceMs: num('LEAVE_GRACE_SECONDS', 60) * 1000,
    minSessionMs: num('MIN_SESSION_SECONDS', 20) * 1000,
    maxSessionMs: num('MAX_SESSION_HOURS', 6) * 3600 * 1000,
    maxUploadBytes: Math.floor(num('MAX_UPLOAD_MB', 10) * 1024 * 1024 * 0.9),
    retentionDays: num('RETENTION_DAYS', 14),
    timezone: process.env.TIMEZONE || 'UTC',
  };
}
