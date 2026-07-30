#!/bin/sh
set -eu

# Workers Builds includes curl and build-essential, but not Rust. Install the
# browser-WASM toolchain only when the build image does not already provide it.
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --profile minimal
fi

export PATH="${HOME}/.cargo/bin:${PATH}"
rustup target add wasm32-unknown-unknown

if ! command -v wasm-pack >/dev/null 2>&1; then
  cargo install wasm-pack --version 0.15.0 --locked
fi

pnpm build
