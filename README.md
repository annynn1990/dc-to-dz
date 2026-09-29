# dc-to-dz

Discord ↔ Discuz (DZ) synchronization service.

## Current setup

- Discord Guild ID: 618042408764178432
- Discord Channel ID: 618042408764178436
- Discord bot listens for messages in that channel.
- Bot tokens are stored only in environment variables.

## Run locally

```bash
npm install
npm start
```

Set the variables from `.env.example` before starting.

## Next step

The DZ side needs the exact forum URL and the method available for creating/reading posts (Discuz API, custom endpoint, or another bridge). Those values will be added without putting secrets into GitHub.
