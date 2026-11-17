<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';
	import ColorPicker from '$lib/ColorPicker.svelte';
	import Slider from '$lib/Slider.svelte';
	import TimelineSheet from '$lib/TimelineSheet.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import Segmented from '$lib/ui/Segmented.svelte';
	import Switch from '$lib/ui/Switch.svelte';
	import ToolButton from '$lib/ui/ToolButton.svelte';
	import type { IconName } from '$lib/ui/icons';
	import {
		AIRBRUSH_PRESET,
		DEFAULT_BRUSH_SETTINGS,
		DEFAULT_DOC_H,
		DEFAULT_DOC_W,
		PEN_PRESET,
		type BrushBlend,
		type BrushSettings,
		type EditApi,
		type LassoMode,
		type LassoOptions,
		type ToolKind
	} from '$lib/gpuPaint';
	import { EMPTY_HISTORY_STATE, type HistoryApi, type HistoryUiState } from '$lib/historyStore';

	type ToolEntry = { id: ToolKind; label: string; short: string; icon: IconName; key: string };

	const PEN_TOOL: ToolEntry = { id: 'pen', label: 'Pen', short: 'Pen', icon: 'pen', key: 'P' };

	const TOOLS: ToolEntry[] = [
		PEN_TOOL,
		{ id: 'airbrush', label: 'Airbrush', short: 'Air', icon: 'airbrush', key: 'A' },
		{ id: 'lasso', label: 'Lasso', short: 'Lasso', icon: 'lasso', key: 'L' },
		{ id: 'fan', label: 'Fan', short: 'Fan', icon: 'fan', key: 'F' },
		{ id: 'fanFade', label: 'Fan Fade', short: 'Fade', icon: 'fanFade', key: 'G' }
	];

	const BLEND_OPTIONS: { value: BrushBlend; label: string; hint: string }[] = [
		{ value: 'wash', label: 'Wash', hint: 'Uniform coverage — opacity builds to the brush opacity' },
		{ value: 'buildup', label: 'Build', hint: 'Paint accumulates with each dab (airbrush)' }
	];

	const LASSO_MODE_OPTIONS: { value: LassoMode; label: string; hint: string }[] = [
		{ value: 'fill', label: 'Fill', hint: 'Fill the enclosed shape with the active color' },
		{ value: 'pull', label: 'Pull-Shape', hint: 'Pull the enclosed shape out of the canvas' }
	];

	const pct = (v: number) => `${Math.round(v * 100)}%`;
	const pxSize = (v: number) => `${Math.round(v * 2)} px`;

	const UI_KEY = 'penelope.ui';

	let color = $state('#1a6cff');
	let brushSettings = $state<BrushSettings>({ ...DEFAULT_BRUSH_SETTINGS });
	let brush = $state<ToolKind>('pen');
	let lassoOptions = $state<LassoOptions>({ mode: 'fill', splat: false });
	let canUndo = $state(false);
	let canRedo = $state(false);
	let editApi = $state<EditApi | null>(null);
	let docW = $state(DEFAULT_DOC_W);
	let docH = $state(DEFAULT_DOC_H);
	let zoom = $state(1);
	let eyedropper = $state(false);
	let resizeMode = $state(false);
	let mirrorView = $state(false);

	let historyApi = $state<HistoryApi | null>(null);
	let historyState = $state<HistoryUiState>({ ...EMPTY_HISTORY_STATE, branches: [] });

	let timelineOpen = $state(false);
	let colorOpen = $state(false);
	let settingsOpen = $state(true);
	let dockEl: HTMLElement | undefined = $state();

	let prefsLoaded = false;

	let isBrush = $derived(brush === 'pen' || brush === 'airbrush');
	let isLasso = $derived(brush === 'lasso');
	let activeTool = $derived(TOOLS.find((tool) => tool.id === brush) ?? PEN_TOOL);
	let toolLabel = $derived(activeTool.label);
	let toolKey = $derived(activeTool.key);
	let docLabel = $derived(`${docW} × ${docH}`);
	let zoomPct = $derived(Math.round(zoom * 100));

	let historyBadge = $derived(
		historyState.exportProgress !== null
			? `${Math.round(historyState.exportProgress * 100)}%`
			: historyState.ready
				? String(historyState.total)
				: ''
	);

	let historyStatus = $derived(
		historyState.exportProgress !== null
			? `Exporting ${Math.round(historyState.exportProgress * 100)}%`
			: historyState.busy
				? 'Working'
				: historyState.ready
					? `${historyState.total} steps`
					: 'Not ready'
	);

	let historyAnnouncement = $derived(
		historyState.exportProgress !== null
			? `Exporting history ${Math.round(historyState.exportProgress * 100)} percent`
			: historyState.busy
				? 'History is working'
				: ''
	);

	$effect(() => {
		if (prefsLoaded) return;
		let stored: boolean | null = null;
		try {
			const raw = localStorage.getItem(UI_KEY);
			if (raw) {
				const saved = JSON.parse(raw) as { settingsOpen?: unknown };
				if (typeof saved.settingsOpen === 'boolean') stored = saved.settingsOpen;
			}
		} catch {
			stored = null;
		}
		settingsOpen = stored ?? window.innerWidth > 900;
		prefsLoaded = true;
	});

	$effect(() => {
		const open = settingsOpen;
		if (!prefsLoaded) return;
		try {
			localStorage.setItem(UI_KEY, JSON.stringify({ settingsOpen: open }));
		} catch {
			// Storage is best-effort: the shell still works without it.
		}
	});

	$effect(() => {
		if (!colorOpen) return;
		function onPointerDownElsewhere(event: PointerEvent) {
			const target = event.target;
			if (dockEl && target instanceof Node && dockEl.contains(target)) return;
			colorOpen = false;
		}
		window.addEventListener('pointerdown', onPointerDownElsewhere, true);
		return () => window.removeEventListener('pointerdown', onPointerDownElsewhere, true);
	});

	function selectBrush(id: ToolKind) {
		brush = id;
		if (id === 'pen') brushSettings = { ...brushSettings, ...PEN_PRESET };
		else if (id === 'airbrush') brushSettings = { ...brushSettings, ...AIRBRUSH_PRESET };
	}

	function toggleResizeMode() {
		resizeMode = !resizeMode;
		if (resizeMode) {
			eyedropper = false;
			colorOpen = false;
			timelineOpen = false;
		}
	}

	function toggleTimeline() {
		timelineOpen = !timelineOpen;
		if (timelineOpen) colorOpen = false;
	}

	function isEditableTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
	}

	function onWindowKeyDown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (isEditableTarget(e.target)) return;
		if (resizeMode) return;
		if (timelineOpen && e.code !== 'KeyH' && e.code !== 'Escape') return;

		switch (e.code) {
			case 'KeyH':
				e.preventDefault();
				toggleTimeline();
				break;
			case 'KeyE':
				eyedropper = !eyedropper;
				break;
			case 'KeyP':
				selectBrush('pen');
				break;
			case 'KeyA':
				selectBrush('airbrush');
				break;
			case 'KeyL':
				selectBrush('lasso');
				break;
			case 'KeyF':
				selectBrush('fan');
				break;
			case 'KeyG':
				selectBrush('fanFade');
				break;
			case 'Escape':
				if (timelineOpen) {
					e.preventDefault();
					timelineOpen = false;
				} else if (colorOpen) {
					colorOpen = false;
				}
				break;
			default:
				break;
		}
	}
</script>

<svelte:window onkeydown={onWindowKeyDown} />

<PaintCanvas
	bind:color
	bind:brushSettings
	bind:brush
	bind:lassoOptions
	bind:canUndo
	bind:canRedo
	bind:editApi
	bind:docW
	bind:docH
	bind:zoom
	bind:eyedropper
	bind:resizeMode
	bind:mirrorView
	bind:historyApi
	bind:historyState
	suspended={timelineOpen}
/>

{#if !resizeMode}
	<nav class="tools" aria-label="Tools">
		<div class="brand">
			<span class="brand-mark" aria-hidden="true">P</span>
			<span class="brand-name">PENELOPE</span>
			<span class="brand-sub pl-mono">NT-2000</span>
		</div>

		<span class="dock-rule" aria-hidden="true"></span>

		{#each TOOLS as tool (tool.id)}
			<ToolButton
				icon={tool.icon}
				label={tool.label}
				caption={tool.short}
				hint="{tool.label} ({tool.key})"
				active={brush === tool.id}
				toggle
				onclick={() => selectBrush(tool.id)}
			/>
		{/each}

		<span class="dock-rule" aria-hidden="true"></span>

		<ToolButton
			icon="eyedropper"
			label="Eyedropper"
			caption="Pick"
			hint="Eyedropper (E)"
			active={eyedropper}
			toggle
			onclick={() => (eyedropper = !eyedropper)}
		/>
	</nav>

	<aside
		id="settings-panel"
		class="props"
		class:props--closed={!settingsOpen}
		inert={!settingsOpen}
		aria-label="Tool settings"
	>
		<header class="props-head">
			<span class="pl-led" class:pl-led--off={!settingsOpen} aria-hidden="true"></span>
			<h2 class="props-title">Tool settings</h2>
			<button
				type="button"
				class="props-close"
				aria-label="Hide tool settings"
				title="Hide settings"
				onclick={() => (settingsOpen = false)}
			>
				<Icon name="close" size={14} />
			</button>
		</header>

		<div class="props-id">
			<span class="props-glyph"><Icon name={activeTool.icon} size={24} strokeWidth={2} /></span>
			<div class="props-id-copy">
				<span class="props-kicker">Active tool</span>
				<span class="props-name">{toolLabel}</span>
			</div>
			<span class="props-key pl-mono" aria-hidden="true">{toolKey}</span>
		</div>

		<div class="props-scroll">
			{#if isBrush}
				<section class="sec" aria-labelledby="sec-tip">
					<h3 class="sec-title" id="sec-tip">Tip</h3>
					<Slider
						bind:value={brushSettings.size}
						min={1}
						max={160}
						step={0.5}
						label="Size"
						format={pxSize}
					/>
					<Slider
						bind:value={brushSettings.hardness}
						min={0}
						max={1}
						step={0.01}
						label="Hardness"
						format={pct}
					/>
					<Slider
						bind:value={brushSettings.spacing}
						min={0.01}
						max={0.4}
						step={0.005}
						label="Spacing"
						format={pct}
					/>
				</section>

				<section class="sec" aria-labelledby="sec-paint">
					<h3 class="sec-title" id="sec-paint">Paint</h3>
					<Slider
						bind:value={brushSettings.opacity}
						min={0}
						max={1}
						step={0.01}
						label="Opacity"
						format={pct}
					/>
					<Slider
						bind:value={brushSettings.flow}
						min={0}
						max={1}
						step={0.01}
						label="Flow"
						format={pct}
						disabled={brushSettings.blend === 'wash'}
						title="Flow — applies in Build mode"
					/>
					<div class="field">
						<span class="field-label">Blend</span>
						<Segmented
							label="Blend mode"
							options={BLEND_OPTIONS}
							value={brushSettings.blend}
							onchange={(next) => (brushSettings.blend = next as BrushBlend)}
						/>
					</div>
				</section>

				<section class="sec" aria-labelledby="sec-dynamics">
					<h3 class="sec-title" id="sec-dynamics">Dynamics</h3>
					<Slider
						bind:value={brushSettings.smoothing}
						min={0}
						max={1}
						step={0.01}
						label="Smoothing"
						format={pct}
					/>
					<Slider
						bind:value={brushSettings.jitter}
						min={0}
						max={1}
						step={0.01}
						label="Jitter"
						format={pct}
					/>
					<Switch
						label="Size pressure"
						hint="Pen pressure scales the brush diameter"
						bind:checked={brushSettings.pressureSize}
					/>
					<Switch
						label="Opacity pressure"
						hint="Pen pressure scales the brush opacity"
						bind:checked={brushSettings.pressureOpacity}
					/>
				</section>
			{:else if isLasso}
				<section class="sec" aria-labelledby="sec-shape">
					<h3 class="sec-title" id="sec-shape">Shape</h3>
					<div class="field">
						<span class="field-label">Mode</span>
						<Segmented
							label="Lasso mode"
							options={LASSO_MODE_OPTIONS}
							value={lassoOptions.mode}
							onchange={(next) => (lassoOptions = { ...lassoOptions, mode: next as LassoMode })}
						/>
					</div>
					<Switch
						label="Splat"
						hint="Scatter paint around the lasso edge"
						bind:checked={lassoOptions.splat}
					/>
				</section>

				<section class="sec" aria-labelledby="sec-lasso-paint">
					<h3 class="sec-title" id="sec-lasso-paint">Paint</h3>
					<Slider
						bind:value={brushSettings.opacity}
						min={0}
						max={1}
						step={0.01}
						label="Opacity"
						format={pct}
					/>
				</section>
			{:else}
				<section class="sec" aria-labelledby="sec-fan-paint">
					<h3 class="sec-title" id="sec-fan-paint">Paint</h3>
					<Slider
						bind:value={brushSettings.opacity}
						min={0}
						max={1}
						step={0.01}
						label="Opacity"
						format={pct}
					/>
				</section>
			{/if}
		</div>

		<footer class="props-foot pl-mono">
			P PEN · A AIR · L LASSO · F FAN · G FADE · E PICK · H HISTORY
		</footer>
	</aside>

	<div class="dockbar" role="toolbar" aria-label="Document actions" bind:this={dockEl}>
		<button
			type="button"
			class="color-cell"
			aria-label="Color {color.toUpperCase()} — open color picker"
			aria-haspopup="dialog"
			aria-expanded={colorOpen}
			title="Color"
			onclick={() => (colorOpen = !colorOpen)}
		>
			<span class="color-swatch" style:background={color} aria-hidden="true"></span>
			<span class="color-copy">
				<span class="color-label">Color</span>
				<span class="color-hex pl-mono">{color.toUpperCase()}</span>
			</span>
			<Icon name={colorOpen ? 'chevronDown' : 'chevronUp'} size={12} />
		</button>

		{#if colorOpen}
			<div class="dock-pop">
				<ColorPicker bind:color bind:open={colorOpen} bind:picking={eyedropper} />
			</div>
		{/if}

		<span class="bar-rule" aria-hidden="true"></span>

		<ToolButton
			icon="undo"
			label="Undo"
			hint="Undo (⌘Z)"
			disabled={!canUndo}
			onclick={() => editApi?.undo()}
		/>
		<ToolButton
			icon="redo"
			label="Redo"
			hint="Redo (⇧⌘Z)"
			disabled={!canRedo}
			onclick={() => editApi?.redo()}
		/>
		<ToolButton
			icon="history"
			label="History"
			hint="History — {historyStatus} (H)"
			active={timelineOpen}
			disclosure
			onclick={toggleTimeline}
		>
			{#if historyState.busy && historyState.exportProgress === null}
				<span class="badge badge--dot" aria-hidden="true"></span>
			{:else if historyBadge}
				<span class="badge pl-mono" aria-hidden="true">{historyBadge}</span>
			{/if}
		</ToolButton>
		<ToolButton
			icon="mirror"
			label="Mirror view"
			hint="Mirror view"
			active={mirrorView}
			toggle
			onclick={() => (mirrorView = !mirrorView)}
		/>
		<ToolButton
			icon="canvas"
			label="Canvas size"
			hint="Canvas size — {docLabel}"
			onclick={toggleResizeMode}
		/>

		<div class="bar-readout pl-mono">
			<span class="bar-doc">DOC <b>{docLabel}</b></span>
			<span class="bar-sep" aria-hidden="true"></span>
			<span class="bar-zoom">ZOOM <b>{zoomPct}%</b></span>
		</div>

		<button
			type="button"
			class="panel-toggle"
			class:panel-toggle--on={settingsOpen}
			aria-label={settingsOpen ? 'Hide tool settings' : 'Show tool settings'}
			aria-pressed={settingsOpen}
			aria-controls="settings-panel"
			title="Toggle tool settings"
			onclick={() => (settingsOpen = !settingsOpen)}
		>
			<Icon name="panel" size={16} strokeWidth={2} />
			<span>Panel</span>
		</button>
	</div>

	<span class="pl-sr" role="status">{historyAnnouncement}</span>

	<TimelineSheet
		api={historyApi}
		state={historyState}
		open={timelineOpen}
		onclose={() => (timelineOpen = false)}
	/>
{:else}
	<div class="resize-hud">
		<div class="resize-card">
			<span class="pl-caps resize-title">Canvas size</span>
			<span class="resize-note">Drag the handles, then apply. Enter applies · Esc cancels.</span>
		</div>
		<button
			type="button"
			class="resize-exit"
			aria-label="Exit canvas resize"
			title="Exit canvas resize (Esc)"
			onclick={toggleResizeMode}
		>
			<Icon name="close" size={16} />
			<span>Exit</span>
		</button>
	</div>
{/if}

<style>
	/* ---------- Left tool dock ---------- */

	.tools {
		position: fixed;
		z-index: 30;
		top: 0;
		left: 0;
		bottom: 0;
		width: var(--pl-tools);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		padding: 10px 8px;
		overflow-y: auto;
		background: var(--pl-metal);
		border-right: 1px solid var(--pl-line);
		box-shadow: inset -1px 0 0 rgba(0, 0, 0, 0.5);
		scrollbar-width: none;
	}

	.tools::-webkit-scrollbar {
		display: none;
	}

	.brand {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 5px;
		padding: 2px 0 10px;
	}

	.brand-mark {
		position: relative;
		display: grid;
		place-items: center;
		width: 42px;
		height: 42px;
		border-radius: var(--pl-radius-sm);
		background: linear-gradient(180deg, #3a3454 0%, #1c1830 52%, #2c2644 100%);
		border: 1px solid #4c4468;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.22),
			inset 0 -1px 0 rgba(0, 0, 0, 0.65),
			0 1px 0 #000;
		color: #cfe8f5;
		font-family: var(--pl-display);
		font-size: 20px;
		font-style: italic;
		font-weight: 800;
		line-height: 1;
	}

	.brand-mark::after {
		content: '';
		position: absolute;
		top: 4px;
		right: 4px;
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--pl-accent);
		box-shadow: 0 0 6px rgba(94, 242, 255, 0.9);
	}

	.brand-name {
		font-size: 8px;
		font-weight: 800;
		letter-spacing: 0.18em;
		color: var(--pl-ink);
	}

	.brand-sub {
		font-size: 7px;
		letter-spacing: 0.14em;
		color: var(--pl-faint);
	}

	.dock-rule {
		flex: none;
		width: 44px;
		height: 1px;
		margin: 6px 0;
		background: var(--pl-line);
		box-shadow: 0 1px 0 rgba(0, 0, 0, 0.6);
	}

	/* ---------- Right properties dock ---------- */

	.props {
		position: fixed;
		z-index: 30;
		top: 0;
		right: 0;
		bottom: var(--pl-bar);
		width: var(--pl-props);
		display: flex;
		flex-direction: column;
		background: var(--pl-metal);
		border-left: 1px solid var(--pl-line);
		box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.03);
		transition:
			transform 150ms var(--pl-ease),
			opacity 150ms var(--pl-ease);
	}

	.props::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		width: 96px;
		height: 2px;
		background: var(--pl-accent);
		pointer-events: none;
	}

	.props--closed {
		transform: translateX(100%);
		opacity: 0;
		pointer-events: none;
	}

	.props-head {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 38px;
		flex: none;
		padding: 0 8px 0 12px;
		background: var(--pl-head-bg);
		border-bottom: 1px solid var(--pl-line);
	}

	.props-title {
		margin: 0;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--pl-dim);
	}

	.props-close {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		margin-left: auto;
		border: 1px solid transparent;
		border-radius: var(--pl-radius-sm);
		color: var(--pl-dim);
	}

	@media (hover: hover) {
		.props-close:hover {
			background: var(--pl-hover);
			border-color: var(--pl-line);
			color: var(--pl-ink);
		}
	}

	.props-id {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: none;
		padding: 12px;
		border-bottom: 1px solid var(--pl-line);
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent);
	}

	.props-glyph {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		flex: none;
		border: 1px solid var(--pl-line-strong);
		border-radius: var(--pl-radius-sm);
		background: var(--pl-sunken-bg);
		box-shadow: var(--pl-bevel);
		color: var(--pl-accent);
	}

	.props-id-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.props-kicker {
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--pl-faint);
	}

	.props-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--pl-ink);
	}

	.props-key {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-left: auto;
		flex: none;
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius-sm);
		background: var(--pl-sunken);
		color: var(--pl-dim);
		font-size: 9px;
	}

	.props-scroll {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 0 12px 16px;
		overflow-y: auto;
		overscroll-behavior: contain;
		touch-action: pan-y;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: thin;
		scrollbar-color: var(--pl-line-strong) transparent;
	}

	.props-foot {
		flex: none;
		padding: 8px 12px;
		border-top: 1px solid var(--pl-line);
		font-size: 8px;
		letter-spacing: 0.1em;
		line-height: 1.7;
		color: var(--pl-faint);
	}

	.sec {
		display: flex;
		flex-direction: column;
		padding: 12px 0;
	}

	.sec + .sec {
		border-top: 1px solid var(--pl-line);
	}

	.sec-title {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 0 0 4px;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--pl-dim);
	}

	.sec-title::before {
		content: '';
		width: 3px;
		height: 9px;
		border-radius: 1px;
		background: var(--pl-accent);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 0 2px;
	}

	.field-label {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--pl-dim);
	}

	.dockbar {
		position: fixed;
		z-index: 32;
		left: var(--pl-tools);
		right: 0;
		bottom: 0;
		height: var(--pl-bar);
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 0 10px;
		background: var(--pl-metal);
		border-top: 1px solid var(--pl-line-strong);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
	}

	.color-cell {
		display: flex;
		align-items: center;
		gap: 9px;
		height: 40px;
		flex: none;
		padding: 0 9px 0 4px;
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius-sm);
		background: var(--pl-panel);
		box-shadow: var(--pl-bevel);
	}

	@media (hover: hover) {
		.color-cell:hover {
			border-color: var(--pl-line-strong);
		}
	}

	.color-swatch {
		width: 30px;
		height: 30px;
		flex: none;
		border-radius: 2px;
		border: 1px solid rgba(255, 255, 255, 0.55);
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.7);
	}

	.color-copy {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
	}

	.color-label {
		font-size: 7px;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--pl-faint);
	}

	.color-hex {
		font-size: 10px;
		letter-spacing: 0.06em;
		color: var(--pl-ink);
	}

	.color-cell :global(svg) {
		color: var(--pl-faint);
	}

	.bar-rule {
		flex: none;
		width: 1px;
		height: 26px;
		margin: 0 5px;
		background: var(--pl-line);
	}

	.bar-readout {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-left: auto;
		padding: 0 4px;
		font-size: 9px;
		letter-spacing: 0.1em;
		color: var(--pl-faint);
		white-space: nowrap;
	}

	.bar-readout b {
		font-weight: 500;
		color: var(--pl-ink);
	}

	.bar-sep {
		width: 1px;
		height: 14px;
		background: var(--pl-line);
	}

	.panel-toggle {
		display: flex;
		align-items: center;
		gap: 7px;
		height: 40px;
		flex: none;
		padding: 0 10px;
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius-sm);
		background: var(--pl-panel);
		color: var(--pl-dim);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		box-shadow: var(--pl-bevel);
	}

	@media (hover: hover) {
		.panel-toggle:hover {
			border-color: var(--pl-line-strong);
			color: var(--pl-ink);
		}
	}

	.panel-toggle--on,
	.panel-toggle--on:hover {
		background: var(--pl-panel);
		border-color: rgba(94, 242, 255, 0.5);
		color: var(--pl-accent);
		box-shadow: inset 0 0 0 1px rgba(94, 242, 255, 0.12);
	}

	.dock-pop {
		position: absolute;
		left: 10px;
		bottom: calc(100% + 10px);
		z-index: 40;
	}

	.badge {
		position: absolute;
		top: 2px;
		right: 2px;
		display: grid;
		place-items: center;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		border: 1px solid var(--pl-line-strong);
		border-radius: 2px;
		background: var(--pl-panel);
		font-size: 8px;
		line-height: 1;
		color: var(--pl-dim);
	}

	.badge--dot {
		min-width: 0;
		width: 6px;
		height: 6px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--pl-live);
		box-shadow: 0 0 6px rgba(255, 61, 154, 0.8);
	}

	/* ---------- Resize mode ---------- */

	.resize-hud {
		position: fixed;
		z-index: 45;
		top: calc(12px + env(safe-area-inset-top, 0px));
		left: max(12px, env(safe-area-inset-left, 0px));
		right: max(12px, env(safe-area-inset-right, 0px));
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		pointer-events: none;
	}

	.resize-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: 36ch;
		padding: 10px 12px;
		background: var(--pl-dock);
		border: 1px solid var(--pl-line-strong);
		border-radius: var(--pl-radius-sm);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
	}

	.resize-title {
		color: var(--pl-accent);
	}

	.resize-note {
		font-size: 10px;
		line-height: 1.45;
		color: var(--pl-dim);
	}

	.resize-exit {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		padding: 0 12px;
		background: var(--pl-panel);
		border: 1px solid var(--pl-line-strong);
		border-radius: var(--pl-radius-sm);
		box-shadow: var(--pl-bevel);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--pl-ink);
	}

	@media (hover: hover) {
		.resize-exit:hover {
			background: var(--pl-hover);
		}
	}

	/* ---------- Responsive: fold the docks into bottom rails ---------- */

	@media (max-width: 900px) {
		.tools {
			top: auto;
			left: 0;
			right: 0;
			bottom: var(--pl-bar);
			width: auto;
			height: 60px;
			flex-direction: row;
			justify-content: flex-start;
			gap: 0;
			padding: 0 4px;
			border-right: 0;
			border-top: 1px solid var(--pl-line);
			box-shadow: none;
		}

		.brand,
		.dock-rule {
			display: none;
		}

		.tools :global(.tb--captioned) {
			width: 52px;
			height: 52px;
		}

		.props {
			top: auto;
			left: 0;
			right: 0;
			bottom: calc(var(--pl-bar) + 60px);
			width: auto;
			max-height: 50vh;
			border-left: 0;
			border-top: 1px solid var(--pl-line-strong);
		}

		.props--closed {
			transform: translateY(12px);
			opacity: 0;
			pointer-events: none;
		}

		.props-id {
			padding: 10px 12px;
		}

		.props-foot {
			display: none;
		}

		.dockbar {
			left: 0;
			padding: 0 6px;
			gap: 2px;
		}

		.dockbar :global(.tb) {
			width: 40px;
			height: 40px;
		}

		.bar-doc,
		.bar-sep {
			display: none;
		}

		.panel-toggle {
			width: 40px;
			justify-content: center;
			padding: 0;
		}

		.panel-toggle span {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.color-copy {
			display: none;
		}

		.color-cell {
			gap: 6px;
			padding: 0 6px 0 4px;
		}

		.bar-readout {
			gap: 8px;
			padding: 0 2px;
		}
	}
</style>
