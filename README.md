# Penelope

Web painting app (SvelteKit + Tailwind), deployed to Cloudflare Workers.

## Develop

```sh
pnpm install
pnpm run dev --open
```

## Build

```sh
pnpm build
pnpm preview
```

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml` (build + Wrangler).

Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

Manual: `pnpm deploy`
