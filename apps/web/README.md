# Taskara Web

RTL-first frontend for Taskara, built with Vite and React Router.

## Stack

- Vite
- React
- Tailwind CSS 4
- next-themes
- HeroUI v3 and React Aria for shared controls and the Support workflow
- Radix UI for the existing navigation and overlay primitives

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
