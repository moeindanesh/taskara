# Taskara Web

Circle-derived frontend for Taskara, rewritten to run on Vite and React Router.

## Stack

- Vite
- React
- Tailwind CSS 4
- next-themes
- Radix UI primitives

## Development

```bash
bun install
bun run dev
```

Default local URL is controlled by `.env`:

```txt
VITE_DEV_HOST=<dev-host>
VITE_DEV_PORT=<dev-port>
```

Environment variables used by the web app:

```txt
VITE_TASKARA_API_URL=<api-url>
```
