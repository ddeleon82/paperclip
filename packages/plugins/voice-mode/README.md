# Voice Mode

A Paperclip plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```



## Install Into Paperclip

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/home/USER/paperclip/packages/plugins/voice-mode","isLocalPath":true}'
```

## Required secrets
- `ELEVENLABS_API_KEY` — your ElevenLabs API key (Scribe + TTS access). Set via the Paperclip secrets API or Instance Settings UI.

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
