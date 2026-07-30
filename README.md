# Penelope
a painting app


## Development

Requirements:

- pnpm
- Rust and Cargo
- `wasm-pack`

```bash
pnpm install
pnpm dev
```

`pnpm dev` compiles `crate/` to WebAssembly and then starts Vite.

## Commands

```bash
pnpm wasm:build  # compile crate/ into crate/pkg/
pnpm wasm:test   # run native Rust unit tests
pnpm build       # typecheck + build the frontend using existing WASM output
pnpm build:full  # compile WASM, then build the frontend
pnpm deploy      # build and deploy dist/ with Cloudflare Workers Assets
```

The generated `.wasm` file is bundled into `dist/` by Vite and served as a
normal static asset by Cloudflare. 

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main`. GitHub Actions:

1. Installs and caches Rust.
2. Tests and compiles the Rust crate to browser WebAssembly.
3. Builds the TypeScript frontend.
4. Deploys `dist/` to Cloudflare with Wrangler.

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
        ↓ packed Float32Array
Stroke resampling (Rust → WebAssembly)
        ↓ evenly spaced brush dabs
Canvas renderer (TypeScript, WebGPU later)
```

The Rust crate is the starting point for CPU-heavy engine features such as
stroke dynamics, document operations, tile-based undo, selections, and file
encoding. GPU-heavy painting and compositing should eventually use WebGPU/WGSL.