# Penelope
a painting app


## Development

Requirements:

- pnpm

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Vite. The latency-sensitive stroke resampler runs directly
in TypeScript to avoid per-pointer-event JavaScript/WebAssembly copies.

## Commands

```bash
pnpm wasm:build  # compile crate/ into crate/pkg/
pnpm wasm:test   # run native Rust unit tests
pnpm build       # typecheck + build the frontend
pnpm build:full  # alias for the complete frontend build
pnpm deploy      # build and deploy dist/ with Cloudflare Workers Assets
```

The Rust crate is retained for future coarse-grained engine work, but it is not
part of the browser's pointer hot path or production bundle.

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main`. GitHub Actions:

1. Tests the retained Rust engine crate.
2. Builds the TypeScript frontend.
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

Rust remains an option for coarse CPU-heavy features such as document
operations, tile-based undo, selections, and file encoding. GPU-heavy painting
and compositing should eventually use WebGPU/WGSL.