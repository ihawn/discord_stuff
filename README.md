# rico

A Discord bot that records voice calls on its own and posts a transcript to a text channel. No commands: nobody has to press anything.

## User guide

### What happens in a call

1. Someone joins a voice channel that Rico watches.
2. Rico joins the channel muted and posts this in the channel's chat: "🔴 This call is being recorded and transcribed. Leave the channel if you do not want to be included."
3. Rico records each speaker on a separate track.
4. When the channel has been empty for one minute (`LEAVE_GRACE_SECONDS`), or after 6 hours (`MAX_SESSION_HOURS`), Rico leaves.
5. Rico transcribes the call and posts it to the transcript channel. On a 4-core server, this takes about 10 minutes for each hour of each speaker's audio.

Rico records one call at a time. Calls shorter than 20 seconds (`MIN_SESSION_SECONDS`) or with no speech are not posted.

### What gets posted

One message in the transcript channel:

- A header line: channel, start time, length and speakers, for example `Lounge · Nov 14, 2026, 7:35 PM · 1 h 31 min · alice, bob`.
- `transcript.txt`: one line per sentence, in time order, as `[mm:ss] name: text`. The time is from the start of the call.
- `audio.ogg`: all speakers mixed. Long calls get a lower bitrate so the file fits the upload limit (`MAX_UPLOAD_MB`). Calls that are too long to fit get the transcript only.

### Privacy

- Everyone in a watched channel is recorded. To not be recorded, leave the channel.
- The per-speaker tracks stay on the server for `RETENTION_DAYS` (default 14), then they are deleted.
- Only add Rico to servers where everyone agrees to this.

## Set up the Discord bot (once)

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it (for example "Rico").
2. Open the **Bot** page:
   - Click **Reset Token** and copy the token. This is `DISCORD_TOKEN`. Keep it secret: anyone who has it can control the bot.
   - Turn off **Public Bot**, so that only you can add it to servers.
   - Leave all **Privileged Gateway Intents** off. Rico does not need them.
3. Open **OAuth2 > URL Generator**:
   - Scopes: `bot`.
   - Bot permissions: **View Channels, Connect, Send Messages, Attach Files**. Do not give more.
   - Open the generated URL, select your server and click **Authorize**.
4. In Discord, open **User Settings > Advanced** and turn on **Developer Mode**.
5. Create a text channel for transcripts. If it is private, give Rico's role access to it. Right-click the channel, click **Copy Channel ID** and use it as `TRANSCRIPT_CHANNEL_ID`.
6. Optional:
   - To watch only some voice channels, copy their IDs into `WATCH_CHANNEL_IDS`, separated by commas.
   - To watch only one server, right-click the server icon and copy its ID into `GUILD_ID`.

## Install on a server (once)

You need a Linux server with Docker (with the compose plugin), git and cron. The transcriber needs about 3 GB of RAM and 2 GB of disk for the Whisper model. It downloads the model on first use.

```bash
git clone https://github.com/<owner>/rico.git ~/rico
cd ~/rico && cp .env.example .env && chmod 600 .env
# Edit .env: set DISCORD_TOKEN, TRANSCRIPT_CHANNEL_ID and IMAGE_PREFIX=ghcr.io/<owner>/rico
deploy/update.sh
(crontab -l 2>/dev/null; echo "*/3 * * * * $HOME/rico/deploy/update.sh >> $HOME/rico/update.log 2>&1") | crontab -
```

The images on ghcr.io must be public, or you must run `docker login ghcr.io` on the server first.

## How it works

- **bot** (Node, discord.js): watches the voice channels, records each speaker to a separate track, and posts the result. If the bot restarts during a call or a post fails, it processes the unfinished session on the next start.
- **transcriber** (Python, faster-whisper): Whisper on the CPU, behind a small HTTP API that only the bot can reach. It transcribes in 10-minute parts, so memory use does not grow with call length. It loads the model when needed and unloads it after five idle minutes.

## Deploy (CI/CD)

1. Push to `main`. GitHub Actions runs the tests, builds the two images and pushes them to `ghcr.io/<owner>/rico/{bot,transcriber}`.
2. On the server, cron runs `deploy/update.sh` every 3 minutes. It pulls this repo and the images, and restarts what changed. It does not restart anything while a call is being recorded (`data/ACTIVE`).

Nothing connects into the server from GitHub, and GitHub has no deploy secrets.

Main is what gets deployed, so use a branch and a PR for anything risky. CI runs on PRs too.

## Settings (`.env`)

See `.env.example`. The ones worth knowing:

- `WATCH_CHANNEL_IDS`: the voice channels to record. Empty means all of them.
- `WHISPER_MODEL`: speed and RAM against accuracy. `small` is much lighter than `large-v3-turbo`.
- `MAX_UPLOAD_MB`: the attachment budget. Longer calls get a lower audio bitrate or only the transcript.
- `TIMEZONE`: the time zone of the header line, for example `America/New_York`. Default `UTC`.

## Troubleshooting

- **No transcript after a call:** run `docker compose logs bot`. If it says `giving up on <session>`, fix the cause and run `docker compose restart bot`. The bot then processes the session again. The audio stays in `data/sessions/` until it is posted.
- **`fetch failed` in the bot log:** the transcriber stopped. Run `docker compose logs transcriber` and `journalctl -k | grep -i oom` to see if it ran out of memory.

## Develop locally

```bash
cd bot && npm ci && npm run build && npm test          # needs ffmpeg
cd transcriber && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
```

With Docker: `docker compose up --build` uses the same `compose.yml` as the server and builds from source.
