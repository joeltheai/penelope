# Penelope

Barebones painting spike with [q5.js](https://q5js.org/learn/?webgpu#coreSection) (WebGPU) + Svelte.

## Dev

```bash
pnpm install
pnpm dev
```

Draw with the mouse/pen. Color picker is in the bottom-right corner.

## Commands

```bash
pnpm check       # svelte-check
pnpm lint        # oxlint (type-aware)
pnpm lint:fix   # oxlint --fix
pnpm fmt         # oxfmt
pnpm fmt:check   # oxfmt --check
pnpm build       # production build → dist/
pnpm preview     # serve dist/
pnpm deploy      # build + wrangler deploy
```

Editor: install the [Oxc](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode) extension (recommended in `.vscode/extensions.json`) for format-on-save and lint fixes.
