# wappers

WhatsApp bridge: [Baileys](https://github.com/WhiskeySockets/Baileys) → webhook (v1)

Receives WhatsApp messages and forwards them to a configurable webhook endpoint.

## Requirements

- Node.js ≥ 22
- pnpm

## Setup

```sh
pnpm install
cp .env.example .env   # fill in your webhook URL
pnpm dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run with hot-reload |
| `pnpm build` | Compile TypeScript |
| `pnpm test` | Run tests |
| `pnpm typecheck` | Type-check without emit |
