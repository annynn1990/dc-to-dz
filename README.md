# dc-to-dz

Discord ↔ Discuz bridge for the Wong Ming Empire forum.

- Discord guild: 618042408764178432
- Discord channel: 618042408764178436
- Discuz forum: https://www.wongmingempire.com/bbswm/forum.php?mod=forumdisplay&fid=53
- Discord → DZ: each new Discord message becomes a new Discuz thread.
- DZ → Discord: new threads appearing on page 1 are forwarded to Discord.
- Bridge-created DZ posts contain a marker to prevent an echo loop.

The bridge uses the standard Discuz login/formhash and posting flow.

## Environment

Never commit the Discord bot token or forum password.

DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=618042408764178432
DISCORD_CHANNEL_ID=618042408764178436
DZ_BASE_URL=https://www.wongmingempire.com/bbswm/
DZ_FORUM_ID=53
DZ_USERNAME=帝國郵政
DZ_PASSWORD=your-password
DZ_POLL_MS=30000

## Run

npm install
npm start

This is a long-running Discord Gateway process. Do not deploy the bot itself as a normal Vercel serverless function; use a persistent Node worker/container/VM.

The first startup seeds the existing page-1 DZ threads and does not repost the existing history. Only newly detected threads are forwarded.
