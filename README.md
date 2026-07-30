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
pnpm build       # bootstrap Rust if needed, then build WASM + TypeScript
pnpm deploy      # build and deploy dist/ with Cloudflare Workers Assets
```

The generated `.wasm` file is bundled into `dist/` by Vite and served as a
normal static asset by Cloudflare. 

For Cloudflare Workers Builds connected to GitHub or GitLab, use:

- Build command: `pnpm build`
- Deploy command: `pnpm exec wrangler deploy`

Cloudflare's build image does not include Rust by default.
`scripts/cloudflare-build.sh` installs the minimal Rust toolchain and pinned
`wasm-pack` version when absent. The deploy step then uploads `dist/`, including
the compiled `.wasm`, through the existing `wrangler.jsonc` assets configuration.

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