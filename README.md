# Penelope

Web painting app (SvelteKit + Tailwind), deployed to Cloudflare Workers.

## Develop

```sh
pnpm install
pnpm run dev --open
```

## Build / preview locally

```sh
pnpm build
pnpm preview
```

These use Vite only. Cloudflare/Wrangler is not involved.

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml` (Vite build + Wrangler deploy).

Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
