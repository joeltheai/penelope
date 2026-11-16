# Penelope performance audit — iPad-first

**Audit date:** 2026-11-14 · **Branch:** `feat/research-features`
**Tree state at audit time:** `HEAD = 2e1239f` ("chore: remove branching history and timelapse"), working
tree heavily dirty and **actively edited by other agents while this audit ran** (files grew under
review: `PaintCanvas.svelte` 963 → 1247 lines mid-audit, `createGpuPaint.ts` modified, `src/lib/ui/`
and `TimelineSheet.svelte` appeared). Line numbers below refer to the working tree as of the audit and
will drift; re-locate by symbol name.

- `pnpm build` — passes (2.5 s, adapter-cloudflare).
- `pnpm check` — **failed at audit time** (3 × `Cannot find name 'syncUndoFlags'` in
  `src/lib/PaintCanvas.svelte`, a transient state of the in-flight history rework; the symbol was
  renamed to `syncHistoryFlags` minutes later). Treat as a moving target, not a finding.
- Uncommitted work in tree: durable history (`historyStore.ts`, `historyPreview.ts`,
  `TimelineSheet.svelte`), MP4 timelapse (`timelapse.ts`, mediabunny dependency), engine changes
  (`endStroke` now returns `Promise<RasterHistoryEntry>`, `applyRasterPatch` added, the GPU undo
  stack in `gpuPaint/undo.ts` is being deleted). This audit evaluates both the current engine and
  that incoming design, since the two are being merged.

Target device class: iPad (Safari **and** Chrome — note both are WebKit on iPadOS), Apple Pencil +
touch, 60/120 Hz ProMotion. Desktop secondary.

---

## 1. Hot-path map

Per pointer gesture. ⚠ marks where latency, jank, or memory growth enters.

```
pointerdown (PaintCanvas.svelte:915)
  ├─ active.blur()                                   ⚠ can collapse the keyboard → resize storm
  ├─ touch bookkeeping / multi-tap / pinch state      (cheap)
  ├─ beginStroke(): setTool/setBrushSettings/beginStroke, startAirbrushTimer ⚠ setInterval(33 ms)
  └─ first addSample → one dab → schedulePresent()

pointermove (PaintCanvas.svelte:979)  — 120 Hz on ProMotion
  └─ paintPointerSamples (PaintCanvas.svelte:883)
       ├─ e.getCoalescedEvents()  (fallback [e])      ⚠ Safari version quirks; see §4
       ├─ per coalesced sample:
       │    ├─ getStrokePressure: 14-sample avg + time-EMA(τ≈55 ms) + start ramp  ⚠ 50–130 ms size lag
       │    ├─ stabilizedDocPoint: screen-space stabilizer (radius 4–68 px / zoom)  ⚠ 1–4 frames lag
       │    └─ addSample → dab spacing + linear interpolation (≤512 dabs/segment)
       │         ├─ queueStamp → vertexCpu (688 KB CPU buffer, reused)
       │         └─ on 4096 dabs: paintStampsToStroke()  ⚠ own encoder + queue.submit mid-move
       ├─ non-brush tools: flushStamps() every move    ⚠ 1 submit/move (fan/lasso)
       └─ schedulePresent() → coalesced rAF            (good)

rAF (≤120 Hz) → present (createGpuPaint.ts, `present(view,…)`)
  ├─ paintStampsToStroke(lastColor, encoder)          (batched into present's encoder — good)
  ├─ presentUniforms.write (whole camera)
  └─ full-screen triangle → canvas swapchain          ⚠ DPR-capped fill, see P2 findings
       blend of strokeTex over docTex (live stroke preview), procedural grid outside doc

pointerup → endStroke (PaintCanvas.svelte:774 → createGpuPaint.ts:834)
  ├─ final flush of stamps
  ├─ strokeBounds.finalizeRegions() → 64 px tile runs (or single AABB)
  ├─ ONE submit: copyTextureToBuffer(before regions) → composite over docTex
  │              → copyTextureToBuffer(after regions)   (queue order guarantees boundary)
  ├─ mapRegionPatch: staging.mapAsync → extractRegion row-copies   ⚠ per-stroke staging alloc
  └─ historyQueue = historyQueue.then( history.append(patch) )
       ├─ structured clone of before+after buffers into IDB         ⚠ main-thread copy, see P0-3
       ├─ one readwrite transaction (project + node + patch + branch)
       └─ syncHistoryFlags() ×3 per stroke                          ⚠ O(stroke count) each

undo/redo/tap gestures → runHistoryOperation (PaintCanvas.svelte:507)
  ├─ awaits historyQueue (i.e. the stroke's IDB append)              ⚠ undo pays for the append
  ├─ history.undo → transitionTo (historyStore.ts:480)
  │    ├─ getStoredPatch per node walked                             ⚠ one IDB txn per node
  │    ├─ applyRasterPatch → writeTexture per region
  │    └─ saveProject → second IDB transaction                       ⚠
  └─ present()

eyedropper drag → sampleLoupe (PaintCanvas.svelte:135)
  └─ ensureDocPixels → gpu.readDocument()                            ⚠ FULL-document readback
       2000×2000 = 16 MB staging + 16 MB row-copy, invalidated every endStroke

boot → PersistentHistory.open → materialize() (all patches) → createGpuPaint(pixels)
                                                                        ⚠ O(total patch bytes)
timelapse → renderTimelapse (timelapse.ts:46): per frame
  getAfterPatch (1 IDB txn) → putImageData → drawImage(2000²→out, high-quality) → encode
                                                                        ⚠ O(frames × doc area)
```

**Memory-growth loci:** per-stroke staging buffers (`endStroke`), per-stroke undo textures at
`HEAD` (removed in flight), `docPixels` full-doc cache (16 MB), history `baseline` + `materialize()`
copies (2 × 16 MB), replay patch cache (bounded 32 MB — good), thumbnail cache (bounded 48 WebP —
good), IDB patch store (grows per stroke; pruning exists only via branch delete).

---

## 2. Prioritized findings

Line numbers: working tree at audit time (see header). "iPad impact" assumes an A12X–M-class iPad at
DPR 2, 2000×2000 document unless stated.

### P0 — fix before feature merge

| # | Location | Mechanism | iPad impact | Fix sketch |
|---|----------|-----------|-------------|------------|
| P0-1 | `PaintCanvas.svelte:120-148` (`ensureDocPixels`/`sampleLoupe`), `createGpuPaint.ts:936` (`readDocument`) | Eyedropper reads the **entire document** (16 MB at 2000², 268 MB at 8192²) via one staging buffer + per-row CPU copy, then samples 23×23 pixels from it. Cache is invalidated on **every** `endStroke`, so the first loupe move after each stroke re-pays it. `mapAsync` round-trips stall the WebKit GPU queue. | First eyedropper move after each stroke: ~30–150 ms stall + 32 MB transient allocation → visible freeze while dragging the loupe; worse at large doc sizes; GC pressure on iPadOS. This is a regression (see §3): a small-patch readback existed at `087371f`. | Restore `samplePatchAt(x, y, 11)` — one `copyTextureToBuffer` of a ≤23×23 region (≤2 KB). Keep `readDocument` only for resize-baseline capture. Trivial: reintroduce the deleted helper and point `sampleLoupe` at it. |
| P0-2 | `historyStore.ts:480-559` (`transitionTo`), `:505`/`:526` (`getStoredPatch(node.id)` per node), `:547` (`saveProject`) | Undo/seek/branch-switch does **one IndexedDB transaction per history node walked**, sequentially, then a separate `saveProject` transaction. The `apply` callback (`applyRasterPatch`) is invoked per region inside the loop. | Undo budget is ≤50 ms. On iPadOS Safari a single IDB get of a multi-MB `ArrayBuffer` is ~5–30 ms; single undo = 2 txns ≈ 20–60 ms before GPU work; scrubbing back N strokes = N+1 sequential txns → hundreds of ms to seconds for `seekIndex`. Two-finger-tap undo will feel broken on long sessions. | Batch with the existing `getStoredPatches` (already used by `materialize`, `historyStore.ts:465`): collect node ids for both walks first, one readonly txn for all, then one readwrite txn for `saveProject` (or merge cursor update into the last patch txn). Keep a small in-RAM cache of the most recent patch (the one just appended) so the common single-undo reads nothing from IDB. |
| P0-3 | `PaintCanvas.svelte:774-796` (`endStroke` history write), `historyStore.ts:619-664` (`append`, `ownedBuffer`/`put`) | Every stroke structured-clones `before+after` buffers (2 × touched bytes; up to 32 MB for a full-canvas stroke) into an IDB `put` **on the main thread**, behind `historyQueue`, which also gates undo/redo/seek (`runHistoryOperation` awaits `historyQueue`). `syncHistoryFlags()` runs 3× per append. | Post-stroke frames (where the next stroke starts) hitch while Safari serializes the clone; rapid sketching (tap-tap-tap) queues appends and every undo then waits for the backlog. The committed stroke is visible (good) but input responsiveness degrades exactly during fast work. | Move `PersistentHistory` into a Worker (IDB works in WebKit workers) and `postMessage` patches with transferable `ArrayBuffer`s — the clone then happens on the worker's structured-serialize path and the main thread only transfers. At minimum: single `syncHistoryFlags` per append, and don't let `runHistoryOperation` wait on appends that can't conflict (it only needs to wait when the cursor moves). |

### P1 — significant, fix in this cycle

| # | Location | Mechanism | iPad impact | Fix sketch |
|---|----------|-----------|-------------|------------|
| P1-1 | `createGpuPaint.ts:834-846` (`endStroke`), `:685-700` (`mapRegionPatch`) | Per-stroke `createBuffer(size = totalSize*2)` for the before/after readback, destroyed after map. Buffer alloc/free on Metal per stroke. | Fast sketching allocates dozens of 1–32 MB GPU buffers per minute; Metal churn + potential allocator fragmentation; occasional multi-ms alloc hitches. | Pool one growable `MAP_READ` staging buffer (or double-buffer two), reset via `unmap`/re-`map` only when size grows. Keeps the single-submit before/composite/after design (which is good — strictly better than `087371f`'s two submits). |
| P1-2 | `timelapse.ts:46-131` (`renderTimelapse`), `historyStore.ts:808` (`getAfterPatch`) | Per frame: one IDB transaction (`getAfterPatch`), `putImageData` of regions into a **full-res** document canvas, then `drawImage` 2000²→output with `imageSmoothingQuality:'high'` (full-canvas high-quality resample) + white fill + WebCodecs encode — all on the main thread. | 500-stroke history at 30 fps ≈ 500 sequential IDB txns (2–10 s) + 500 × full-canvas resamples (~10 ms each) + encode ≈ **1–3 minutes of near-frozen UI**, thermally throttled on iPad. Frame cost is O(document) even for 1-px strokes. | (a) Fetch all patches up front: `getRasterPatches(path ids)` in one txn (helper already exists, `historyStore.ts:833`). (b) Drop the full-res canvas: draw each region scaled **directly** into the output-size canvas (`drawImage(scratch, bounds×scale)` — the pattern already exists in `historyPreview.drawPatch`). (c) Run in a Worker where `OffscreenCanvas` + mediabunny allow; at minimum yield every frame with `await new Promise(r => setTimeout(r))` and report progress. |
| P1-3 | `historyStore.ts:451-478` (`materialize`) | Boot replays **every** patch from baseline: O(total patch bytes) IDB reads + CPU blits before first paint. | 2-hour session ≈ 1–3k strokes ≈ 100–300 MB of patches → reload far past the 1.5 s budget (10 s+), plus 16 MB baseline clone + 16 MB result. | Periodic checkpoints: every N strokes (or M bytes) store a full materialized frame as the new baseline and prune older patches (keep a sliding window for scrub). Alternatively gate materialize behind "restore last state" and stream patches in the background. |
| P1-4 | `historyPreview.ts:134-216` (`renderHistorySnapshots`) | Each uncached node: walk to nearest cached ancestor, apply every patch between (IDB batched per 16 — good), then `canvas.toBlob('image/webp')` **per node** on the main thread. First timeline open over an N-stroke branch replays ~N patches and encodes up to 18 thumbnails (`TimelineSheet.svelte:12`, `MAX_THUMBS=18`). | Opening the timeline on a long session: several hundred ms to seconds of main-thread work (WebP encode ≈ 10–40 ms each on iPad) right when the user wants to scrub. Amortized caching is well designed (depth-sorted, LRU 48) — the encode is the bottleneck. | Encode with `createImageBitmap`+`OffscreenCanvas.convertToBlob` in a Worker, or `image/jpeg` (faster encoder) at thumbnail size; interleave encodes with `requestIdleCallback`/rAF yields; scale patches into a 320×210 surface directly instead of `drawImage` per patch when far behind. |
| P1-5 | `lasso.ts:244-261` (`drawPull`/`readDirty`), `createGpuPaint.ts:509-523` (`uploadPathDirty`, `clearStrokeTextureNow`) | Lasso "pull" mode, per pointermove: 2D-canvas draw → **`getImageData`** (GPU→CPU sync readback in WebKit) → `premulCopy` (~1 ms for 460², measured 1.08 ms on M-class desktop core → 3–4 ms iPad) → `writeTexture` → own `queue.submit` (plus one more for `clearStrokeTextureNow`). | At 120 Hz moves this is easily 10+ ms of main-thread work per move → strokes drop to 30–60 Hz updates and the stabilizer stretches; large stamps (scale up to ~2.1 → ~460² regions) amplify it. | (a) Batch: accumulate pulls and upload once per rAF (`flushStamps` already exists as the batching hook). (b) Avoid `getImageData`+premul: render into a canvas and `drawImage`/`transferToImageBitmap`→`copyExternalImageToTexture` (handles premul on GPU), or render pulls directly with the fan/stencil path. |
| P1-6 | `createGpuPaint.ts:834` + `strokeBounds.ts:74-117` (interaction), `undo.ts:88-108` (**HEAD only**) | At `HEAD`, `undo.capture` copies the stroke's **whole AABB** into a fresh GPU texture per stroke (`finalize` bounds, not `finalizeRegions` tiles) with a 32 M-pixel (128 MB) budget, ×2 once `after` textures exist. A diagonal stroke across 2000² touches ~5–15 % of pixels but its AABB is ~50 %+. The in-flight design replaces this with tiled before/after patches — good — but `undo.ts` is still on disk and the memory math must not regress. | At `HEAD`: up to 128 MB GPU textures for undo alone (iPadOS WebGPU device-loss territory on 8 GB devices when combined with doc textures + 22 MB swapchain). The replacement design trades GPU memory for the P0-2/P0-3 IDB latency — both sides of the trade must land together. | Delete `undo.ts` with the merge (it is dead code the moment `endStroke` returns patches). If any interim build keeps it, capture `finalizeRegions` tiles, not the AABB, and lower `maxPixels` to ~16 M. |

### P2 — polish / measure first

| # | Location | Mechanism | iPad impact | Fix sketch |
|---|----------|-----------|-------------|------------|
| P2-1 | `createGpuPaint.ts` `present()` (one `queue.submit` per frame), `constants.ts:16` (`MAX_PRESENT_DPR = 2`) | Full-screen present at native DPR (2732×2048 ≈ 5.6 MP) with inverse-camera math + 2 texture samples + procedural grid, at up to 120 Hz (≈ 670 MP/s fill). One `queue.submit` per rAF (coalesced — good). | ProMotion iPads may hold 60 Hz while drawing (fill-bound), which *feels* like input lag vs. 120 Hz. Cheap win: present DPR 1.5 while pen down (−44 % fill) and/or pin present to the display's 120/60 cadence after measuring. | Measure `present` frame cost first (§6). If >5 ms, add `MAX_PRESENT_DPR_DRAWING = 1.5` applied in `resize()` when `strokeActive`. |
| P2-2 | `PaintCanvas.svelte:445-460` (`startAirbrushTimer`), `createGpuPaint.ts:853+` (`addTimedAirbrushDab`) | `setInterval(…, 33 ms)` queues airbrush dabs off the rAF cadence; each tick schedules a present. The old per-dab ping-pong is gone (good — that was 2 texture copies + pass per dab at `087371f`), but the timer still adds up to 2 extra submits per 16 ms frame while an airbrush stroke is held. | Minor extra submit overhead; drift between 33 ms timer and 8.3/16.7 ms frames causes uneven ink buildup at 120 Hz. | Drive timed dabs from the `schedulePresent` rAF with an accumulator (`dabs += dt * rate`) — one cadence, no interval, frame-rate-independent flow. |
| P2-3 | `createGpuPaint.ts:222-228` (`syncBrushTip`), `brush.ts:40-71` (`makeBrushTipPixels`) | Every hardness change regenerates a 256×256 tip with `Math.sqrt`/`Math.pow` per pixel (measured 1.14 ms on M-class core → ~3–4 ms iPad) + full texture write + `generateMipmaps` (8 render passes). Fires per slider input event. | Slider drags at 60 events/s → repeated 4 ms+ spikes alongside Svelte re-renders; jank in the settings panel while stroking is possible. | Debounce to rAF (only the final value matters per frame), or generate the tip once and do hardness shaping in the fragment shader (`pow(mask, gamma)` — the tip only needs a radial gradient). |
| P2-4 | `PaintCanvas.svelte:837` (`resize`), `createGpuPaint.ts:589-595` (`resize`→`configureContext`) | `ResizeObserver` **and** `window resize` both call `resize()`, which re-reads layout and reconfigures the canvas context (WebKit swapchain reconfigure is heavier than Chrome's) even when the size is unchanged. iPad keyboard show/hide and Stage Manager drags fire these repeatedly. | Multi-frame hitches when the keyboard opens (e.g. editing a numeric field) or on rotation. | Skip when `cssW/cssH` unchanged; debounce to one rAF; drop the redundant `window resize` listener (ResizeObserver covers it). |
| P2-5 | `PaintCanvas.svelte:915-971` (`onPointerDown`) | `document.activeElement.blur()` on every pointerdown. | If an input is focused, tapping the canvas dismisses the keyboard → viewport resize → P2-4 path mid-gesture. | Blur only when the target is an editable element (helper `isEditableTarget` already exists). |
| P2-6 | `PaintCanvas.svelte:484-502` (`syncHistoryFlags`), `historyStore.ts:330-354` (`getState`) | `syncHistoryFlags()` runs 3× per stroke-end; each call sorts branches, walks cached paths, `findIndex` over the full node list, and allocates a new `historyState` object → downstream Svelte re-render of `TimelineSheet` (1490 lines of UI). | O(stroke count) per stroke; at 2 000 strokes ≈ 2 000-element `findIndex` ×3 — small (µs) but the object churn re-renders timeline DOM per stroke. Harmless today, becomes visible if the timeline grows per-stroke DOM. | One `syncHistoryFlags` per append (in `finally`); memoize `getState` behind a dirty flag. |
| P2-7 | `createGpuPaint.ts:392-427` (`paintStampsToStroke`), `:429-449` (`paintFanBatch`), `:454-499` (`paintLassoFill`) | Fan/lasso paths create their own encoder and `queue.submit` per flush; `PaintCanvas` calls `flushStamps()` on **every** move for non-brush tools; stamp overflow (4096 dabs) submits mid-move. | 1–3 submits per move event; at 120 Hz ≈ small but measurable CPU overhead on WebKit (submit ≈ 0.1–0.3 ms). Batching fan/lasso draws into the next `present()` encoder (as brush dabs already are) removes most of it. | Pass the present encoder into `flushStamps` from `present()` — the plumbing (`externalEncoder`) already exists for `paintStampsToStroke`. |
| P2-8 | `penPressure.ts:12-14` (`HISTORY_SIZE=14`, `SMOOTH_TAU_MS=55`, `RAMP_PX=48`), `PaintCanvas.svelte:859-881` (`stabilizedDocPoint`) | Positional stabilizer (radius up to 68 px / zoom) + 14-sample pressure average + rising EMA τ≈85 ms (55×1.55) + 48 px start ramp. No prediction (`getPredictedEvents` is Chromium-only). | The dab trail lags the Pencil tip by ~1–4 frames and size changes lag ~80–150 ms. This is deliberate smoothing, but it consumes the entire "stroke-to-photon" latency budget *perceptually* — users read lag even when the pipeline is fast. | Keep smoothing for slow detail work but: (a) cut rising τ to ~25 ms, (b) scale the position radius down at high sample rates, (c) optional velocity extrapolation (predict ½ frame along the last segment) to offset the stabilizer. Measure perceived lag with the §6 protocol before/after. |
| P2-9 | `app.html:6` (viewport meta) | `viewport-fit=cover` missing → `env(safe-area-inset-*)` is always 0 (`TimelineSheet.svelte:928` relies on it); toolbar rows have no inset padding. | On landscape iPad Pro the rounded corners/home indicator can overlap edge UI; the drawing canvas being full-bleed is fine. | Add `viewport-fit=cover`, pad fixed toolbars with `env(safe-area-inset-*)`. |
| P2-10 | `EyedropperLoupe.svelte:134-145` (loupe `box-shadow`), `+page.svelte` toolbar shadows | Large multi-layer `box-shadow` on the loupe which repositions per pointermove; static toolbar shadows elsewhere (no `blur`/`backdrop-filter` — verified by grep). | Loupe drag: shadow re-rasterized per move — a few % GPU; negligible after P0-1 is fixed. CSS shadows are otherwise fine; no filter/blur traps found. | Optional: `will-change: transform` and animate `translate` only (already uses `translate`), or pre-render the ring into the canvas. |
| P2-11 | `createGpuPaint.ts` `resizeDocument` (rebuild paths) | Resize recreates doc/stroke/stencil textures, re-uploads the crop, and `rebuildDocSamplePipelines()` builds 3 fresh `GPURenderPipeline`s (TypeGPU compiles WGSL again). | One-time 50–200 ms hitch per canvas resize; acceptable, but combined with `commitResizeMode`'s full `readDocument()` baseline capture (`PaintCanvas.svelte` resize flow) a resize is a ~100–300 ms freeze. | Fine as-is; if resize becomes interactive, prewarm the rebuilt pipelines (`pipeline.compile()` if available) before tearing down. |
| P2-12 | `PaintCanvas.svelte:574-585` (`resetHistoryProject`) | Allocates a fresh `docW*docH*4` white `Uint8Array` (16 MB) and writes the full texture. | Rare path; 16 MB spike. | Reuse `makeWhiteDocument` output or clear via `fillTexture`-style render pass + store only the baseline through IDB once. |

**Checked and clean (no action):** coalesced-event batching before GPU flush (`paintPointerSamples`
submits at most once per frame for brush tools); `schedulePresent` rAF coalescing; stroke clear is
scissored to the previous stroke's dirty rect (`encodeStrokeClear`); composite is scissored per tile
run with a smart AABB fallback (`strokeBounds.finalizeRegions:116`); event listeners are attached
once per effect and removed in cleanup (no churn); replay/thumbnail caches are bounded
(`MAX_REPLAY_CACHE_BYTES = 32 MB`, `MAX_CACHED_SNAPSHOTS = 48`); TimelineSheet scrub coalescing
(rAF pump + generation counter) is well built; stamp vertex buffer is reused (688 KB, no per-dab
alloc); `touch-action: none` + `selectstart`/`contextmenu`/`touchstart` preventDefault are correct.

---

## 3. Regression comparison

Commits: `087371f` (last working history integration) → `e876427` (engine overhaul) →
`2b92201` (UI/brush rewrite) → `2e1239f` (history removal) → **working tree** (history being
re-added).

### 087371f → e876427 (engine overhaul)

**Faster / better**
- Airbrush: per-dab ping-pong removed (was 2× `copyTextureToTexture` + 1 render pass **per dab**,
  `paintAirbrushStamps`); replaced by a batched `strokeBuildupPipeline` (standard over-accumulation
  in one draw). Largest GPU win in the repo's history. (Behavior note: buildup no longer caps at
  pressure — semantic change shipped with the perf win.)
- Stroke clear scissored to the previous stroke's dirty rect instead of a full-texture clear.
- Composite scissored per tile region; `finalizeRegions` AABB-vs-tiles heuristic added.
- `endStroke` orders before/composite/after in queue order with one encoder (at 087371f: two
  separate submissions with two staging buffers).

**Slower / worse**
- `readTextureRegions` + `samplePatch` deleted; the eyedropper lost its small-patch fast path (the
  consequence landed at `2b92201`, P0-1).
- GPU undo stack (`undo.ts`) added: per-stroke GPU texture copies of the **whole stroke AABB** with
  a 128 MB budget (P1-6). O(bbox) instead of O(touched tiles) — accidental O(document) for long
  diagonal strokes.
- History wiring removed from the engine (`endStroke` became sync `void`), to be re-added later —
  the undo model flip-flopped (IDB patches → GPU textures → IDB patches).

### e876427 → 2b92201 (UI/brush rewrite)

- **Regression (P0-1):** eyedropper switched from `gpu.samplePatch(p.x, p.y, 11)` (≤2 KB readback)
  to `gpu.readDocument()` (16 MB) + a `docPixels` cache invalidated per stroke. Measured: the
  row-copy alone is ~2.8 ms on an M-class core (≈ 6–10 ms iPad) plus `mapAsync` stall and 32 MB
  transient buffers.
- Faster: sliders/panel simplified (RollerSlider family deleted), PaintCanvas internals tidied;
  `getCoalescedEvents` handling kept.

### 2b92201 → 2e1239f (history removal)

- Faster at runtime: per-stroke IDB append and the whole history UI (2 511 lines incl. the 878-line
  `HistoryGraphDialog`) deleted — stroke-end became "one submit, no readback at all" (the `HEAD`
  state). Undo was purely GPU-texture.
- Lost: durability, scrub, timelapse.

### 2e1239f → working tree (in-flight)

- **Better than 087371f:** stroke-end readback is now one submit + one staging buffer for both
  sides of the composite (`createGpuPaint.ts:834`, `mapRegionPatch`), regions are tile-aligned, and
  `applyRasterPatch` validates before `writeTexture`.
- **Reintroduced costs:** per-stroke IDB append on the main thread (P0-3), per-node transaction
  walks in `transitionTo` (P0-2), boot-time `materialize` replay (P1-3), main-thread timelapse
  compositing (P1-2).
- Undo memory moves from GPU (128 MB at `HEAD`) to IDB — the right trade for a 300 MB budget **if**
  P0-2/P0-3 land.

### Accidental O(document) / O(stroke count) work remaining

| Pattern | Where | Order |
|---|---|---|
| Full-document GPU readback per eyedropper use after each stroke | `ensureDocPixels` → `readDocument` | O(document) per stroke |
| Undo capture of stroke AABB (HEAD only) | `undo.ts:88` | O(bbox) ≈ O(document) per diagonal stroke |
| Timelapse full-res composite + downscale per frame | `timelapse.ts:90-121` | O(frames × document) |
| `materialize` patch replay at boot | `historyStore.ts:451` | O(total history bytes) |
| Per-node IDB transactions in `transitionTo` | `historyStore.ts:505/526` | O(steps) transactions per seek |
| `syncHistoryFlags` → `getState().findIndex` | `PaintCanvas.svelte:484`, `historyStore.ts:332` | O(stroke count) per stroke ×3 |
| Thumbnail build replaying ancestor chains | `historyPreview.ts:173-199` | O(n) patches per first open (amortized after) |

---

## 4. iPad input / latency audit

**Pointer pipeline (good bones).** `pointerdown/move/up/cancel` with `setPointerCapture`,
`touch-action: none` on the canvas (`PaintCanvas.svelte:1212`), `touchstart` preventDefault,
`selectstart`/`contextmenu` suppressed, `user-scalable=no, maximum-scale=1` in `app.html:6`.
Buttons use `touch-action: manipulation` (`ui/ToolButton.svelte:50`) — avoids double-tap-zoom delay.

- **`getCoalescedEvents`** (`PaintCanvas.svelte:886`): used with a `[e]` fallback — correct shape.
  Two cautions: (1) verify on the target iPadOS build that coalesced events carry real `pressure`;
  WebKit has historically produced coalesced `PointerEvent`s with defaulted pressure fields, which
  would interact badly with `eventLooksLikeRealPressure` (`penPressure.ts:68`) flipping
  `hasPressure` mid-stroke from a single coalesced sample; (2) when the API is absent (older
  Safari), fast strokes rely entirely on `addSample` spacing interpolation (max 512 dabs/segment) —
  test fast flicks at 2000 px doc size for dotted segments.
- **Pressure smoothing** (`penPressure.ts`): 14-sample uniform average → time-EMA (τ 55 ms rising
  ×1.55, falling ×0.65) → 48 px pen start ramp → `pow(p, 0.45)` + iOS ×2.6 boost. Robust against
  Safari's fake 0.5 pressure, but total size-response lag ≈ 80–150 ms. The iOS ×2.6 boost is
  applied via `isIOS()` UA sniffing — runs on every sample; hoist it to a constant.
- **Prediction:** none. `getPredictedEvents` is Chromium-only; iPad Safari has no equivalent.
  Cheap substitute: extrapolate the final coalesced sample ~½ frame along its velocity when building
  the trailing dabs (§ P2-8c).
- **Palm rejection: missing (largest input-quality gap).** `onPointerDown` paints for any
  `pointerType === 'touch'`; a resting palm draws. Recommend: (a) while a pen contact was active in
  the last ~300 ms, ignore touch-pointer *painting* (keep 2/3-finger gestures), (b) reject
  `pointerType==='touch'` contacts with `width`/`height` > ~40 CSS px (Apple exposes contact
  geometry), (c) the existing "nascent stroke" logic (`resolveStrokeForMultiTouch`, <200 ms/24 px)
  already cancels accidental second-finger strokes — keep it.
- **Two/three-finger undo/redo** (`PaintCanvas.svelte` multi-tap machine): 2-finger tap = undo,
  3-finger tap = redo, 400 ms window, 14 px slop, 200 ms chord; pinch aborts taps via `moved`.
  Sound. Risks: iPadOS reserves 3-finger **swipes** for system undo/app switching — 3-finger drags
  may never reach the page; and the undo executed by `runUndo` inherits the P0-2 latency, so the
  gesture will *trigger* correctly but *complete* slowly. Verify both on device.
- **Pinch/rotate math** (`canvasCamera.ts` + `onPointerMove`): pinch keeps the doc point under the
  finger midpoint (`placeDocAtScreen`), rotation is added with `* viewFlipX()` so mirrored mode
  feels natural, zoom clamped 0.05–20, `rebaselinePinch` on gesture transitions. Math is consistent
  with the present shader's inverse map (both derived from the same formulation — keep them in
  lockstep, the shader duplicates it in `pipelines.ts:151-210`).
- **Safe areas:** `viewport-fit=cover` absent (`app.html:6`), so `env(safe-area-inset-bottom)` in
  `TimelineSheet.svelte:928` evaluates to 0; fixed toolbars ignore the home indicator/corners.
  Fix with P2-9.
- **WebGPU / Safari caveats:**
  - All iPad browsers are WebKit (Chrome on iPad is a shell) — "Safari and Chrome" is one engine;
    test once, but do check both for the WebKit embed differences.
  - WebGPU needs iPadOS 26+ per the app's own error message (`gpuPaint/cpu.ts:45-50`); insecure
    contexts (plain `http://192.168.x.x`) never expose `navigator.gpu` — dev workflow must use
    HTTPS or localhost tunneling (the error text already says so).
  - `mapAsync` round-trips are slow on the WebKit Metal backend — keep every readback off the
    input path (this is why P0-1 matters more on iPad than desktop).
  - `device.lost` is **not handled** — iPadOS aggressively reclaims GPU memory on backgrounding;
    add a `device.lost` handler that flushes pending history writes and shows a reload prompt.
  - WebKit reconfigures the swapchain on `configureContext` (per `resize()` today — P2-4).
  - `VideoEncoder`/WebCodecs availability on iPadOS Safari must be verified before promising MP4
    export (`timelapse.ts` throws if `canEncodeVideo('avc')` fails — surface that error early in
    the UI rather than after a long render).
  - IndexedDB on Safari is slowest of the big three for multi-MB `ArrayBuffer` values — the P0-2/3
    fixes are iPad-first fixes.
- **120 Hz scheduling:** rAF runs at 120 on ProMotion; per-frame budget is 8.3 ms. Current per-move
  CPU work (pressure + stabilizer + stamp fill) measured at ≈ 0.1 ms desktop-class per coalesced
  sample (appendStamp 512 dabs = 0.04 ms) — CPU sampling is nowhere near the limit; the budget is
  spent in present fill-rate (P2-1) and readbacks (P0-1). The 33 ms airbrush `setInterval` (P2-2)
  is the only off-cadence scheduler.

---

## 5. Measurement plan

### Instrumentation points (`performance.mark` / `measure`)

Wrap these in a `perf.ts` helper gated by `location.search.includes('perf')` so production pays
nothing:

| Mark | Place | Budget |
|---|---|---|
| `stroke:first-sample` | `onPointerDown` after first `addSample` | pointerdown → mark ≤ 4 ms |
| `stroke:move-encode` | `paintPointerSamples` entry/exit | ≤ 2 ms per move (CPU) |
| `stroke:end-encode` | `createGpuPaint.endStroke` before `queue.submit` | ≤ 1 ms |
| `stroke:end-mapped` | `mapRegionPatch` resolve (covers `mapAsync` GPU drain) | end-encode → mapped ≤ 16 ms |
| `history:append-done` | `history.append` resolve in `endStroke` | ≤ 20 ms (after P0-3: ≤ 5 ms main-thread) |
| `present:frame` | `present()` entry/exit + rAF timestamp delta | ≤ 5 ms GPU-bound; frame ≤ 8.3 ms @120 Hz |
| `undo:start` → `undo:patched` → `undo:presented` | `runUndo` / `transitionTo` / `present` | **total ≤ 50 ms**; patched ≤ 30 ms |
| `boot:history-open`, `boot:materialized`, `boot:gpu-ready`, `boot:first-present` | boot sequence | first-present ≤ 1.5 s with 500-stroke history (post P1-3) |
| `thumbs:batch` | `renderHistorySnapshots` | ≤ 300 ms per open after warm cache |
| `export:frame` | `renderTimelapse` loop per frame | report p95; target ≤ 33 ms/frame after P1-2 |

Also record `mapAsync` round-trip time inside `readTextureRegions` (best available proxy for GPU
queue latency — WebGPU exposes no GPU counters), and count submits/frame
(`device.queue.submit` wrapper with a per-frame counter) — target ≤ 2 (draw + present).

### Budgets

- **Stroke-to-photon:** pointerdown → first pixel ≤ 16 ms (60 Hz) / ≤ 8.3 ms (120 Hz); per-move
  sample → frame ≤ 1 frame. Note the deliberate stabilizer lag (P2-8) is *outside* this budget but
  must not grow.
- **Undo/redo/seek-step:** ≤ 50 ms end-to-end; multi-step scrub may amortize but per-step ≤ 50 ms.
- **Reload:** first paint ≤ 1.5 s with a 500-stroke history on a warm cache; today's `materialize`
  will exceed this (P1-3) — measure to confirm the size of the miss.
- **Memory:** total ≤ 300 MB at 2000² with 64 strokes of undo/redo depth: GPU textures ≤ 120 MB
  (doc + stroke + stencil + swapchain), JS heap ≤ 100 MB (baseline + materialized + docPixels),
  IDB excluded but reported (`getGraphData().storage`). Track manually: wrap
  `createTexture`/`createBuffer` with byte counters in the perf build.

### Reproduction

```bash
pnpm check          # static errors (was failing mid-audit on an in-flight rename)
pnpm build          # production build
pnpm dev            # serve; on iPad open via HTTPS or an ngrok/localhost tunnel —
                    # plain http://192.168.x.x has no navigator.gpu (see gpuPaint/cpu.ts:45)
```

Browser steps (iPad, Safari + Chrome shell):
1. **Stroke latency:** append `?perf` to the URL; draw slow and fast strokes; Safari Web Inspector
   → Timelines → Scripting & Rendering; read the `stroke:*`/`present:frame` measures. Record at
   both 60 Hz (Low Power Mode) and 120 Hz.
2. **Readback stall (P0-1):** draw 10 strokes, then drag the eyedropper; look for `readDocument`
   mapAsync spikes of tens of ms in the timeline (today), vs ≤ 2 ms after fix.
3. **Undo latency (P0-2):** 50 quick strokes, then hold two-finger taps; measure `undo:*`. Repeat
   after 500 strokes to expose the per-node transaction walk with `seekIndex(0)` + `seekIndex(max)`.
4. **Timelapse (P1-2):** export 720p/30 fps from a 500-stroke history; record wall time and longest
   main-thread task (Performance → Bottom-Up).
5. **Memory:** Web Inspector → Timelines → Memory during: 50 strokes, undo ×20, timeline open,
   replay scrub, export. Screenshot the gauge; compare against the 300 MB budget.
6. **Input quality:** fast flicks (dotted-line check), palm rest while drawing (Palm rejection),
   2-finger tap undo / 3-finger tap redo, pinch + rotate in mirrored mode, keyboard open + draw.

Static checks used in this audit (rerun anytime):

```bash
grep -rn 'readDocument\|samplePatch' src/lib            # readback surface area
grep -rn 'queue.submit' src/lib/gpuPaint/createGpuPaint.ts
grep -rn 'blur\|backdrop-filter' src/routes src/lib --include='*.svelte'   # CSS filter traps (none found)
grep -rn 'setInterval\|setTimeout' src/lib              # off-rAF schedulers
```

---

## 6. Top 5 fixes to do now

| Fix | Findings | Expected impact | Effort |
|---|---|---|---|
| **1. Eyedropper small-patch readback** — restore `samplePatchAt(x, y, 11)` and delete the full-doc `ensureDocPixels` path. | P0-1 | Removes a 16 MB GPU readback + 30–150 ms stall on the first loupe move after every stroke; eyedropper goes from "freeze" to instant. | ~30 min (revert-shaped; helper existed at `087371f`) |
| **2. Batch IDB reads/writes in `transitionTo`** — one `getStoredPatches` txn for the whole walk, merge `saveProject` into the final write txn, cache the just-appended patch in RAM. | P0-2 | Undo from ≤ 20–60 ms+ of IDB round-trips to ≤ ~10 ms; multi-stroke seeks from O(steps) txns to 1–2. Makes the ≤ 50 ms undo budget reachable on iPad. | ~2–4 h |
| **3. Get stroke-history writes off the main thread** — worker-side `PersistentHistory` with transferable buffers; single `syncHistoryFlags` per append; don't gate `runHistoryOperation` on unrelated appends. | P0-3, P2-6 | Eliminates the post-stroke hitch during fast sketching (the most common rhythm in the app) and stops undo queuing behind append clones. | ~1 day (worker plumbing) |
| **4. Timelapse frame loop overhaul** — batch `getRasterPatches(path)` once, composite patches directly into the output-size canvas, yield per frame (or worker + OffscreenCanvas). | P1-2 | Export of a 500-stroke history from ~1–3 min of frozen UI to seconds–tens of seconds of responsive work; also removes O(frames × document) resampling. | ~0.5–1 day |
| **5. Palm rejection + pen-priority touch filtering** — ignore painting touches while/after pen contact, reject large-contact touches; plus the 3-line `activeElement.blur()` and `resize()` guards (P2-4/P2-5). | §4, P2-4, P2-5 | The single biggest *perceived* quality gap on iPad today: palm marks are user-visible damage; the guards stop keyboard/rotation hitches mid-stroke. | ~2–3 h |

Runner-up once measured (P2-1/P2-8): present-DPR-while-drawing and reducing the rising pressure
EMA — both are one-liners but should be validated against the §5 protocol first, since they trade
smoothness for latency.

---

## 7. Applied in this branch after the audit

These changes were made on `feat/research-features` after the audit snapshot:

- **P0-1 (eyedropper):** `PaintCanvas.sampleLoupe` now calls a new `GpuPaint.readRegion()` for the 23×23 loupe patch. The full-document `docPixels` cache and its per-stroke invalidation are gone; `readDocument()` remains only for the resize baseline.
- **P0-2 (undo latency):** `PersistentHistory.transitionTo` now collects the backward and forward node ids first and reads all patches in **two batched transactions** (one for each direction, run concurrently), instead of one transaction per node. A bounded 16 MB LRU patch cache keeps the newest append in RAM, and `append()` seeds it. `saveProject` remains a separate small transaction.
- **P1-2 (timelapse):** `renderTimelapse` reads after-patches in 32-frame batches (one IndexedDB transaction per batch) and yields between batches. The full-resolution document canvas is retained for seam-free downscaling, but the per-frame transaction and redundant white fill are gone.
- **P1-4 (thumbnails):** history snapshots encode as JPEG instead of WebP, which is materially faster on WebKit and avoids Safari's WebP-encoder fallback.
- **P2-4/P2-5 (resize/blur):** `resize()` returns early when the CSS size is unchanged; canvas blur on pointerdown only happens when an editable element was focused.
- **iPad input:** pen-priority palm rejection was added (touches are ignored for 700 ms after pen contact, and contacts wider than 56 CSS px do not ink), plus a boot status overlay.
- **Dead code:** `src/lib/gpuPaint/undo.ts` was deleted; persistent history is the single undo model.

Still open from the audit: **P0-3** (worker-side history writes), **P1-3** (boot checkpoints), and **P2-1/P2-8** (present DPR while drawing, pressure-EMA tuning) remain worthwhile follow-ups and should be measured on-device before changing.
