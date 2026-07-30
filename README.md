# Penelope
a painting app


## Development

Requirements:

- pnpm

```bash
pnpm install
pnpm dev
```

## Commands

```bash
pnpm test     # run TypeScript unit tests
pnpm build    # typecheck + build the frontend into dist/
pnpm preview  # serve the production build locally
pnpm deploy   # build and deploy dist/ with Cloudflare Workers Assets
```

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main`. GitHub Actions:

1. Installs Node and pnpm.
2. Runs tests and builds the TypeScript frontend.
3. Deploys `dist/` to Cloudflare with Wrangler.

Add these repository secrets under **GitHub → Settings → Secrets and variables →
Actions**:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare token with Workers Scripts edit access.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID owning the Worker.

Disable the Cloudflare repository build integration under the Worker's
**Settings → Builds**. GitHub Actions now performs and deploys the build, so
leaving both enabled would trigger two deployments for each push.

## Architecture

```text
Pointer Events (TypeScript)
        ↓ coalesced actual samples + temporary predictions
Stroke smoothing and resampling (TypeScript)
        ↓ evenly spaced brush dabs
Dirty-region Canvas renderer (TypeScript, WebGPU later)
```

GPU-heavy painting and compositing should eventually use WebGPU/WGSL.

## Ink performance capture

Add `?perf=1` to the app URL to enable the low-overhead ink telemetry overlay:

```text
https://penelope.hates.workers.dev/?perf=1
```

Draw several representative fast, slow, curved, and pressure-varying strokes.
After each stroke, the overlay reports p50/p95 input age, animation-frame wait,
frame interval, stroke CPU work, and Canvas composite CPU work. The same summary
is logged to the browser console as `[Penelope ink performance]`.

These are JavaScript pipeline measurements. They do not include browser
compositor queuing, display scanout, or physical Apple Pencil latency, so use
them to compare builds on the same iPad rather than as absolute input-to-photon
latency.
