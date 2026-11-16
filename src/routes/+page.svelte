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

	type ToolEntry = { id: ToolKind; label: string; icon: IconName; key: string };

	const TOOLS: ToolEntry[] = [
		{ id: 'pen', label: 'Pen', icon: 'pen', key: 'P' },
		{ id: 'airbrush', label: 'Airbrush', icon: 'airbrush', key: 'A' },
		{ id: 'lasso', label: 'Lasso', icon: 'lasso', key: 'L' },
		{ id: 'fan', label: 'Fan', icon: 'fan', key: 'F' },
		{ id: 'fanFade', label: 'Fan Fade', icon: 'fanFade', key: 'G' }
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
	let toolLabel = $derived(TOOLS.find((tool) => tool.id === brush)?.label ?? 'Pen');
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
	<header class="topbar">
		<div class="topbar-inner">
			<div class="brand">
				<span class="brand-dot" aria-hidden="true"></span>
				<span class="brand-name">PENELOPE</span>
				<span class="brand-tag pl-mono" aria-hidden="true">2K</span>
			</div>

			<div class="readouts pl-mono">
				<span class="readout"><span class="readout-key">DOC</span>{docLabel}</span>
				<span class="readout-rule" aria-hidden="true"></span>
				<span class="readout"><span class="readout-key">ZOOM</span>{zoomPct}%</span>
			</div>

			<div class="flags">
				{#if mirrorView}
					<span class="flag pl-mono">MIRROR</span>
				{/if}
			</div>
		</div>
	</header>

	<nav class="rail" class:rail--tucked={colorOpen} class:rail--sheet={settingsOpen} aria-label="Tools">
		{#each TOOLS as tool (tool.id)}
			<ToolButton
				icon={tool.icon}
				label={tool.label}
				hint="{tool.label} ({tool.key})"
				active={brush === tool.id}
				toggle
				marker
				onclick={() => selectBrush(tool.id)}
			/>
		{/each}
		<span class="rail-rule" aria-hidden="true"></span>
		<ToolButton
			icon="eyedropper"
			label="Eyedropper"
			hint="Eyedropper (E)"
			active={eyedropper}
			toggle
			marker
			onclick={() => (eyedropper = !eyedropper)}
		/>
		<ToolButton
			icon="mirror"
			label="Mirror view"
			hint="Mirror view (M)"
			active={mirrorView}
			toggle
			marker
			onclick={() => (mirrorView = !mirrorView)}
		/>
	</nav>

	<button
		type="button"
		class="settings-tab"
		class:settings-tab--open={settingsOpen}
		aria-label={settingsOpen ? 'Hide tool settings' : 'Show tool settings'}
		aria-expanded={settingsOpen}
		aria-controls="settings-panel"
		title="Tool settings"
		onclick={() => (settingsOpen = !settingsOpen)}
	>
		<Icon name={settingsOpen ? 'chevronRight' : 'chevronLeft'} size={13} />
		<span class="tab-text pl-caps">Settings</span>
	</button>

	<aside
		id="settings-panel"
		class="settings"
		class:settings--closed={!settingsOpen}
		inert={!settingsOpen}
		aria-label="Tool settings"
	>
		<div class="settings-head">
			<h2 class="settings-title">Settings</h2>
			<span class="settings-tool pl-mono">{toolLabel.toUpperCase()}</span>
			<button
				type="button"
				class="settings-close"
				aria-label="Hide tool settings"
				title="Hide settings"
				onclick={() => (settingsOpen = false)}
			>
				<Icon name="chevronDown" size={14} />
			</button>
		</div>

		<div class="settings-scroll">
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
	</aside>

	<div class="transport" role="toolbar" aria-label="Document actions">
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
		<span class="bar-rule" aria-hidden="true"></span>
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
		<span class="bar-rule" aria-hidden="true"></span>
		<ToolButton
			icon="mirror"
			label="Mirror view"
			hint="Mirror view (M)"
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
	</div>

	<span class="pl-sr" role="status">{historyAnnouncement}</span>

	<TimelineSheet
		api={historyApi}
		state={historyState}
		open={timelineOpen}
		onclose={() => (timelineOpen = false)}
	/>

	<div class="dock" class:dock--sheet={settingsOpen} bind:this={dockEl}>
		{#if colorOpen}
			<div class="dock-pop">
				<ColorPicker bind:color bind:open={colorOpen} bind:picking={eyedropper} />
			</div>
		{/if}
		<button
			type="button"
			class="dock-btn"
			aria-label="Color {color.toUpperCase()} — open color picker"
			aria-haspopup="dialog"
			aria-expanded={colorOpen}
			title="Color"
			onclick={() => (colorOpen = !colorOpen)}
		>
			<span class="dock-swatch" style:background={color} aria-hidden="true"></span>
			<span class="dock-hex pl-mono">{color.toUpperCase()}</span>
			<span class="dock-chev"><Icon name={colorOpen ? 'chevronDown' : 'chevronUp'} size={12} /></span>
		</button>
	</div>

	<div class="status pl-mono" aria-hidden="true">
		<span class="status-value">{zoomPct}%</span>
		<span class="status-dot">·</span>
		<span class="status-value">{docLabel}</span>
		<span class="status-dot">·</span>
		<span>{toolLabel.toUpperCase()}</span>
	</div>
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
	.topbar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 30;
		height: calc(var(--pl-topbar) + env(safe-area-inset-top, 0px));
		padding-top: env(safe-area-inset-top, 0px);
		background:
			linear-gradient(180deg, rgba(48, 41, 108, 0.94), rgba(11, 8, 30, 0.96)),
			var(--pl-panel);
		border-bottom: 1px solid var(--pl-line);
		box-shadow:
			0 1px 0 rgba(255, 255, 255, 0.06),
			0 14px 36px rgba(0, 0, 0, 0.5);
	}

	/* Neon hairline under the chrome header. */
	.topbar::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: -1px;
		height: 1px;
		background: var(--pl-neon);
		opacity: 0.6;
		pointer-events: none;
	}

	/* Faint horizontal lens streak, the Y2K kind. */
	.topbar::before {
		content: '';
		position: absolute;
		top: 0;
		right: 6%;
		width: 320px;
		height: 100%;
		background: linear-gradient(
			90deg,
			transparent,
			rgba(255, 255, 255, 0.05) 38%,
			rgba(255, 143, 228, 0.16) 50%,
			rgba(87, 247, 255, 0.1) 62%,
			transparent
		);
		filter: blur(7px);
		opacity: 0.8;
		pointer-events: none;
	}

	.topbar-inner {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		height: var(--pl-topbar);
		padding-left: max(var(--pl-gutter), env(safe-area-inset-left, 0px));
		padding-right: max(var(--pl-gutter), env(safe-area-inset-right, 0px));
		gap: 12px;
	}

	.brand {
		position: relative;
		display: flex;
		align-items: center;
		gap: 9px;
		min-width: 0;
	}

	/* Soft lens flare behind the wordmark. */
	.brand::before {
		content: '';
		position: absolute;
		left: -26px;
		top: 50%;
		width: 190px;
		height: 70px;
		translate: 0 -50%;
		background: radial-gradient(
			ellipse at 28% 50%,
			rgba(87, 247, 255, 0.28),
			rgba(143, 123, 255, 0.12) 42%,
			transparent 72%
		);
		filter: blur(10px);
		pointer-events: none;
	}

	.brand-dot {
		position: relative;
		width: 9px;
		height: 9px;
		flex: none;
		border-radius: 50%;
		background: radial-gradient(circle at 34% 28%, #ffffff, #7dfbff 36%, #2fa6ff 68%, #7a5cff 100%);
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.55),
			0 0 14px rgba(87, 247, 255, 0.85),
			0 0 26px rgba(87, 247, 255, 0.35);
		animation: twinkle 4.5s ease-in-out infinite;
	}

	@keyframes twinkle {
		0%,
		100% {
			opacity: 0.82;
			box-shadow:
				0 0 0 1px rgba(255, 255, 255, 0.55),
				0 0 12px rgba(87, 247, 255, 0.7),
				0 0 22px rgba(87, 247, 255, 0.26);
		}
		50% {
			opacity: 1;
			box-shadow:
				0 0 0 1px rgba(255, 255, 255, 0.7),
				0 0 18px rgba(87, 247, 255, 0.95),
				0 0 34px rgba(255, 75, 216, 0.38);
		}
	}

	.brand-name {
		position: relative;
		font-family: var(--pl-display);
		font-size: 15px;
		font-style: italic;
		font-weight: 800;
		letter-spacing: 0.26em;
		line-height: 1;
		white-space: nowrap;
		background: linear-gradient(94deg, #ffffff 4%, #b9fdff 38%, #8f7bff 68%, #ff8fe4 100%);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		filter: drop-shadow(0 0 8px rgba(87, 247, 255, 0.35));
	}

	.brand-tag {
		position: relative;
		padding: 2px 6px;
		border: 1px solid var(--pl-line-strong);
		border-radius: 4px;
		background: rgba(87, 247, 255, 0.08);
		color: var(--pl-accent);
		font-size: 8px;
		letter-spacing: 0.16em;
		box-shadow: 0 0 10px rgba(87, 247, 255, 0.16);
	}

	.readouts {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 10.5px;
		color: #cfe4ff;
		white-space: nowrap;
		text-shadow: 0 0 12px rgba(87, 247, 255, 0.25);
	}

	.readout {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}

	.readout-key {
		font-size: 9px;
		letter-spacing: 0.16em;
		color: var(--pl-accent);
		opacity: 0.72;
	}

	.readout-rule {
		width: 1px;
		height: 12px;
		background: linear-gradient(180deg, transparent, var(--pl-line-strong), transparent);
	}

	.flags {
		display: flex;
		justify-content: flex-end;
	}

	.flag {
		padding: 2px 7px;
		border: 1px solid var(--pl-line-strong);
		border-radius: 999px;
		background: rgba(87, 247, 255, 0.08);
		font-size: 9px;
		letter-spacing: 0.12em;
		color: var(--pl-accent);
		box-shadow: 0 0 12px rgba(87, 247, 255, 0.18);
	}

	.rail {
		position: fixed;
		z-index: 28;
		left: max(8px, env(safe-area-inset-left, 0px));
		top: 50%;
		translate: 0 -50%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		width: var(--pl-rail);
		padding: 5px;
		background: var(--pl-panel-bg);
		border: 1px solid var(--pl-line);
		border-radius: 16px;
		box-shadow:
			var(--pl-shadow),
			var(--pl-top-highlight),
			inset 0 0 0 1px rgba(255, 255, 255, 0.03);
		transition: opacity 140ms var(--pl-ease);
	}

	/* Neon filament along the rail. */
	.rail::before {
		content: '';
		position: absolute;
		top: 10px;
		bottom: 10px;
		left: -1px;
		width: 1px;
		background: linear-gradient(
			180deg,
			transparent,
			rgba(87, 247, 255, 0.55) 22%,
			rgba(255, 75, 216, 0.4) 78%,
			transparent
		);
		opacity: 0.65;
		pointer-events: none;
	}

	/* The color popover opens over the left column; tuck the rail so it never sits under it. */
	.rail--tucked {
		opacity: 0;
		pointer-events: none;
	}

	.rail-rule {
		width: 26px;
		height: 1px;
		margin: 5px 0;
		background: linear-gradient(90deg, transparent, var(--pl-line-strong), transparent);
	}

	.settings {
		position: fixed;
		z-index: 26;
		top: calc(68px + env(safe-area-inset-top, 0px));
		bottom: calc(92px + env(safe-area-inset-bottom, 0px));
		right: max(8px, env(safe-area-inset-right, 0px));
		width: var(--pl-settings);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--pl-panel-bg);
		border: 1px solid var(--pl-line);
		border-radius: 16px;
		box-shadow:
			var(--pl-shadow),
			var(--pl-top-highlight),
			inset 0 0 0 1px rgba(255, 255, 255, 0.03);
		transition:
			transform 150ms var(--pl-ease),
			opacity 150ms var(--pl-ease);
	}

	/* Neon rim on the settings card. */
	.settings::before {
		content: '';
		position: absolute;
		top: 0;
		left: 24px;
		right: 24px;
		height: 1px;
		background: var(--pl-neon);
		opacity: 0.7;
		pointer-events: none;
	}

	.settings--closed {
		transform: translateX(calc(100% + 24px));
		opacity: 0;
		pointer-events: none;
	}

	.settings-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 42px;
		padding: 0 10px 0 13px;
		border-bottom: 1px solid var(--pl-line);
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), transparent);
	}

	.settings-title {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 0;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--pl-ink);
	}

	.settings-title::before {
		content: '';
		width: 5px;
		height: 5px;
		flex: none;
		rotate: 45deg;
		background: var(--pl-accent);
		box-shadow:
			0 0 8px rgba(87, 247, 255, 0.8),
			0 0 16px rgba(87, 247, 255, 0.35);
	}

	.settings-tool {
		margin-left: auto;
		padding: 2px 7px;
		border: 1px solid var(--pl-line);
		border-radius: 999px;
		background: rgba(87, 247, 255, 0.07);
		font-size: 8.5px;
		letter-spacing: 0.14em;
		color: var(--pl-accent);
	}

	.settings-close {
		display: none;
		place-items: center;
		width: var(--pl-tap);
		height: var(--pl-tap);
		margin-right: -8px;
		border-radius: 6px;
		color: var(--pl-dim);
	}

	.settings-scroll {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 13px;
		padding: 10px 13px 16px;
		overflow-y: auto;
		overscroll-behavior: contain;
		touch-action: pan-y;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: thin;
		scrollbar-color: var(--pl-line-strong) transparent;
	}

	.settings-scroll::-webkit-scrollbar {
		width: 8px;
	}

	.settings-scroll::-webkit-scrollbar-thumb {
		background: var(--pl-line-strong);
		border-radius: 4px;
	}

	.sec {
		display: flex;
		flex-direction: column;
	}

	.sec + .sec {
		border-top: 1px solid var(--pl-line);
		padding-top: 12px;
	}

	.sec-title {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 0 0 3px;
		font-size: 9.5px;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #86e9ff;
	}

	.sec-title::before {
		content: '';
		width: 10px;
		height: 2px;
		border-radius: 2px;
		background: var(--pl-neon);
		box-shadow: 0 0 8px rgba(87, 247, 255, 0.5);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 0 2px;
	}

	.field-label {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--pl-dim);
	}

	.settings-tab {
		position: fixed;
		z-index: 27;
		top: 50%;
		right: max(8px, env(safe-area-inset-right, 0px));
		translate: 0 -50%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 82px;
		background: var(--pl-chrome);
		border: 1px solid var(--pl-line-strong);
		border-radius: 999px 0 0 999px;
		color: var(--pl-accent);
		box-shadow:
			0 0 18px rgba(87, 247, 255, 0.22),
			inset 0 1px 0 rgba(255, 255, 255, 0.25);
		transition:
			transform 150ms var(--pl-ease),
			opacity 150ms var(--pl-ease);
	}

	/* Keep the tab slim but give it a 44px-wide touch target on its canvas side. */
	.settings-tab::after {
		content: '';
		position: absolute;
		inset: 0 0 0 -24px;
	}

	.settings-tab--open {
		transform: translateX(calc(-1 * var(--pl-settings)));
		border-radius: 999px 0 0 999px;
		border-right-color: transparent;
	}

	.tab-text {
		display: none;
	}

	.transport {
		position: fixed;
		z-index: 30;
		left: 50%;
		bottom: calc(14px + env(safe-area-inset-bottom, 0px));
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: 3px;
		height: var(--pl-transport);
		padding: 0 6px;
		background: var(--pl-panel-bg);
		border: 1px solid var(--pl-line-strong);
		border-radius: 16px;
		box-shadow:
			var(--pl-shadow),
			var(--pl-top-highlight),
			0 0 26px rgba(87, 247, 255, 0.14);
	}

	.bar-rule {
		flex: none;
		width: 1px;
		height: 26px;
		margin: 0 5px;
		background: linear-gradient(180deg, transparent, var(--pl-line-strong), transparent);
	}

	.badge {
		position: absolute;
		top: 4px;
		right: 3px;
		display: grid;
		place-items: center;
		min-width: 15px;
		height: 15px;
		padding: 0 4px;
		border-radius: 999px;
		border: 1px solid var(--pl-line-strong);
		background: linear-gradient(180deg, rgba(87, 247, 255, 0.24), rgba(87, 247, 255, 0.06));
		font-size: 8.5px;
		line-height: 1;
		color: var(--pl-accent);
		box-shadow: 0 0 10px rgba(87, 247, 255, 0.25);
	}

	.badge--dot {
		top: 8px;
		right: 8px;
		min-width: 0;
		width: 7px;
		height: 7px;
		padding: 0;
		border: 0;
		background: var(--pl-accent);
		box-shadow:
			0 0 10px rgba(87, 247, 255, 0.9),
			0 0 18px rgba(87, 247, 255, 0.4);
	}

	.dock {
		position: fixed;
		z-index: 32;
		left: max(var(--pl-gutter), env(safe-area-inset-left, 0px));
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		transition: opacity 140ms var(--pl-ease);
	}

	.dock-btn {
		display: flex;
		align-items: center;
		gap: 9px;
		height: var(--pl-tap);
		padding: 0 12px 0 6px;
		background: var(--pl-panel-bg);
		border: 1px solid var(--pl-line-strong);
		border-radius: 999px;
		box-shadow:
			0 10px 26px rgba(0, 0, 0, 0.5),
			var(--pl-top-highlight),
			0 0 22px rgba(87, 247, 255, 0.16);
		transition: transform 130ms var(--pl-ease);
	}

	.dock-btn:active {
		transform: scale(0.98);
	}

	@media (hover: hover) {
		.dock-btn:hover {
			background: var(--pl-panel-bg);
			border-color: var(--pl-accent);
		}
	}

	.dock-swatch {
		width: 32px;
		height: 32px;
		flex: none;
		border-radius: 50%;
		border: 2px solid rgba(255, 255, 255, 0.72);
		box-shadow:
			inset 0 2px 4px rgba(255, 255, 255, 0.35),
			inset 0 -2px 4px rgba(0, 0, 0, 0.35),
			0 0 16px rgba(87, 247, 255, 0.28);
	}

	.dock-hex {
		font-size: 10px;
		letter-spacing: 0.14em;
		color: var(--pl-ink);
		text-shadow: 0 0 10px rgba(87, 247, 255, 0.4);
	}

	.dock-chev {
		color: var(--pl-accent);
		opacity: 0.75;
	}

	.dock-pop {
		position: absolute;
		left: 0;
		bottom: calc(100% + 8px);
		z-index: 40;
	}

	.status {
		position: fixed;
		z-index: 20;
		right: max(16px, env(safe-area-inset-right, 0px));
		bottom: calc(33px + env(safe-area-inset-bottom, 0px));
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 9.5px;
		letter-spacing: 0.14em;
		color: var(--pl-faint);
		pointer-events: none;
		text-shadow: 0 0 10px rgba(87, 247, 255, 0.2);
	}

	.status-value {
		color: #bfe6ff;
	}

	.status-dot {
		color: var(--pl-accent);
		opacity: 0.55;
	}

	.resize-hud {
		position: fixed;
		z-index: 45;
		top: calc(10px + env(safe-area-inset-top, 0px));
		left: max(10px, env(safe-area-inset-left, 0px));
		right: max(10px, env(safe-area-inset-right, 0px));
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		pointer-events: none;
	}

	.resize-card {
		display: flex;
		flex-direction: column;
		gap: 3px;
		max-width: 34ch;
		padding: 9px 13px;
		background: var(--pl-panel-bg);
		border: 1px solid var(--pl-line);
		border-radius: 14px;
		box-shadow:
			var(--pl-shadow),
			var(--pl-top-highlight),
			0 0 22px rgba(87, 247, 255, 0.14);
	}

	.resize-title {
		color: var(--pl-accent);
		text-shadow: 0 0 10px rgba(87, 247, 255, 0.45);
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
		height: var(--pl-tap);
		padding: 0 15px;
		background: var(--pl-chrome);
		border: 1px solid var(--pl-line-strong);
		border-radius: 999px;
		box-shadow:
			var(--pl-shadow),
			var(--pl-top-highlight),
			0 0 18px rgba(87, 247, 255, 0.22);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--pl-ink);
		transition: transform 130ms var(--pl-ease);
	}

	.resize-exit:active {
		transform: scale(0.97);
	}

	@media (hover: hover) {
		.resize-exit:hover {
			background: var(--pl-hover);
		}
	}

	@media (max-width: 900px) {
		.settings {
			top: auto;
			left: max(12px, env(safe-area-inset-left, 0px));
			right: max(12px, env(safe-area-inset-right, 0px));
			width: auto;
			bottom: calc(76px + env(safe-area-inset-bottom, 0px));
			max-height: 44vh;
		}

		.rail--sheet {
			opacity: 0;
			pointer-events: none;
		}

		.dock--sheet {
			opacity: 0;
			pointer-events: none;
		}

		.settings--closed {
			transform: translateY(14px);
			opacity: 0;
			pointer-events: none;
		}

		.settings-head {
			min-height: var(--pl-tap);
		}

		.settings-close {
			display: grid;
		}

		.settings-tab {
			top: auto;
			left: max(12px, env(safe-area-inset-left, 0px));
			right: max(12px, env(safe-area-inset-right, 0px));
			bottom: calc(76px + env(safe-area-inset-bottom, 0px));
			translate: none;
			width: auto;
			height: var(--pl-tap);
			flex-direction: row-reverse;
			justify-content: space-between;
			padding: 0 12px;
			border-radius: var(--pl-radius);
		}

		.settings-tab::after {
			display: none;
		}

		.settings-tab--open {
			display: none;
		}

		.tab-text {
			display: inline;
			color: var(--pl-dim);
		}
	}

	@media (max-width: 720px) {
		.status {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.readouts .readout:first-child,
		.readout-rule {
			display: none;
		}

		.topbar-inner {
			gap: 8px;
		}

		.brand-name {
			letter-spacing: 0.12em;
		}

		.dock-hex {
			display: none;
		}

		.dock-btn {
			padding: 0 5px;
		}

		.settings-tool {
			display: none;
		}
	}

	@media (max-width: 420px) {
		.dock {
			bottom: calc(76px + env(safe-area-inset-bottom, 0px));
		}

		.settings-tab {
			left: auto;
			width: auto;
			padding: 0 14px;
			gap: 10px;
		}
	}
</style>
