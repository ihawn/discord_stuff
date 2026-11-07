# discord_stuff

A bot that records Discord voice calls on its own and posts a transcript with the audio to a text channel. No commands, no one has to press anything.

## How it works

- **bot** (Node, discord.js): watches the voice channels. When the first person joins, it joins muted, posts a "this call is being recorded" notice in the channel's chat, and records each speaker to their own track. When the channel has been empty for a minute it leaves, transcribes each track, and posts `transcript.txt` and `audio.ogg` (all speakers mixed) to the transcript channel.
- **transcriber** (Python, faster-whisper): CPU Whisper behind a small HTTP API. Loads the model when needed and drops it after five idle minutes, so it does not hold RAM on a shared server.
- Per-speaker FLAC tracks stay in `data/sessions/` for `RETENTION_DAYS` (default 14).
- If the bot restarts mid-call or Discord fails, the unfinished session is transcribed and posted on the next start.

## One-time Discord setup

1. Developer Portal > New Application > Bot. Copy the token. No privileged intents are needed.
2. Invite it: OAuth2 > URL Generator, scope `bot`, permissions **View Channel, Connect, Send Messages, Attach Files**.
3. Create the transcript channel and copy its ID (Developer Mode > right-click > Copy Channel ID).
4. Put both in `.env` on the server (copy `.env.example`).

## Deploy (CI/CD)

1. Push to `main`. GitHub Actions runs the tests, builds the two images and pushes them to `ghcr.io/ihawn/discord_stuff/{bot,transcriber}`.
2. On the server, `deploy/update.sh` runs from cron every 3 minutes: it pulls this repo and the images and restarts what changed. It waits while a call is being recorded (`data/ACTIVE`).

Nothing connects into the server from GitHub, and no deploy secrets live in GitHub.

Server install (once):

```bash
git clone https://github.com/ihawn/discord_stuff.git ~/projects/discord-recorder
cd ~/projects/discord-recorder && cp .env.example .env && chmod 600 .env   # then fill it in
(crontab -l 2>/dev/null; echo '*/3 * * * * /home/ihawn/projects/discord-recorder/deploy/update.sh >> /home/ihawn/projects/discord-recorder/update.log 2>&1') | crontab -
```

## Develop locally

```bash
cd bot && npm ci && npm run build && npm test          # needs ffmpeg
cd transcriber && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
```

With Docker: `docker compose up --build` uses the same `compose.yml` as the server and builds from source.

Then `git push`. Main is what gets deployed, so use a branch and a PR for anything risky; CI runs on PRs too.

## Settings (`.env`)

See `.env.example`. The ones worth knowing: `WATCH_CHANNEL_IDS` limits recording to specific voice channels (empty means all); `WHISPER_MODEL` trades speed and RAM for accuracy (`small` is a lot lighter than `large-v3-turbo`); `MAX_UPLOAD_MB` is the attachment budget, and longer calls get a lower audio bitrate or just the transcript.

## Privacy

Everyone in a watched channel is recorded and told so in the channel chat. Only add the bot to servers where that is agreed.
