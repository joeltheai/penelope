<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';
	import HistoryGraphDialog from '$lib/HistoryGraphDialog.svelte';
	import ColorPicker from '$lib/ColorPicker.svelte';
	import SliderSize from '$lib/SliderSize.svelte';
	import SliderOpacity from '$lib/SliderOpacity.svelte';
	import SliderSpacing from '$lib/SliderSpacing.svelte';
	import {
		type BrushKind,
		type LassoMode,
		type LassoOptions,
		DEFAULT_DOC_W,
		DEFAULT_DOC_H
	} from '$lib/gpuPaint';
	import {
		EMPTY_HISTORY_STATE,
		type HistoryApi,
		type HistoryUiState
	} from '$lib/historyStore';

	const BRUSHES: {
		id: BrushKind;
		label: string;
		spacing: number;
	}[] = [
		{ id: 'pen', label: 'Pen', spacing: 0.005 },
		{ id: 'airbrush', label: 'Airbrush', spacing: 0.12 },
		{ id: 'lasso', label: 'Lasso', spacing: 0.02 },
		{ id: 'fan', label: 'Fan', spacing: 0.02 },
		{ id: 'fanFade', label: 'Fan Fade', spacing: 0.02 }
	];

	const LASSO_MODES: { id: LassoMode; label: string }[] = [
		{ id: 'fill', label: 'Fill' },
		{ id: 'pull', label: 'Pull-Shape' }
	];

	let color = $state('#1a6cff');
	let size = $state(8);
	let opacity = $state(1);
	let spacing = $state(0.005);
	let brush = $state<BrushKind>('pen');
	let lassoOptions = $state<LassoOptions>({
		mode: 'fill',
		splat: false
	});
	let pressureSize = $state(false);
	let pressureOpacity = $state(true);
	let canUndo = $state(false);
	let canRedo = $state(false);
	let historyApi = $state<HistoryApi | null>(null);
	let historyState = $state<HistoryUiState>({ ...EMPTY_HISTORY_STATE });
	let docW = $state(DEFAULT_DOC_W);
	let docH = $state(DEFAULT_DOC_H);
	let zoom = $state(1);
	let spacingOpen = $state(false);
	let eyedropper = $state(false);
	let resizeMode = $state(false);
	let mirrorView = $state(false);
	let historyOpen = $state(false);

	const PANEL_KEY = 'penelope.sliderPanel';
	let panelX = $state(12);
	let panelY = $state(0);
	let panelReady = $state(false);
	let draggingPanel = $state(false);
	let panelEl: HTMLElement | undefined = $state();

	$effect(() => {
		if (!('window' in globalThis)) return;
		try {
			const raw = localStorage.getItem(PANEL_KEY);
			if (raw) {
				// SAFETY: PANEL_KEY is only ever written by savePanel() as { x, y } numbers;
				// JSON.parse returns `any`, so assert the stored shape.
				const saved = JSON.parse(raw) as { x: number; y: number };
				panelX = saved.x;
				panelY = saved.y;
			} else {
				panelY = Math.round(window.innerHeight / 2 - 140);
			}
		} catch {
			panelY = Math.round(window.innerHeight / 2 - 140);
		}
		panelReady = true;
	});

	function clampPanel(x: number, y: number) {
		const w = panelEl?.offsetWidth ?? 40;
		const h = panelEl?.offsetHeight ?? 280;
		const maxX = Math.max(0, window.innerWidth - w);
		const maxY = Math.max(0, window.innerHeight - h);
		return {
			x: Math.min(maxX, Math.max(0, x)),
			y: Math.min(maxY, Math.max(0, y))
		};
	}

	function savePanel() {
		try {
			localStorage.setItem(PANEL_KEY, JSON.stringify({ x: panelX, y: panelY }));
		} catch {
			/* ignore */
		}
	}

	function onPanelDragStart(e: PointerEvent) {
		if (e.button !== 0) return;
		// SAFETY: bound to the panel drag handle element in the template; currentTarget is that HTMLElement.
		const handle = e.currentTarget as HTMLElement;
		const startX = e.clientX;
		const startY = e.clientY;
		const origX = panelX;
		const origY = panelY;
		draggingPanel = true;
		handle.setPointerCapture(e.pointerId);

		function onMove(ev: PointerEvent) {
			const next = clampPanel(origX + (ev.clientX - startX), origY + (ev.clientY - startY));
			panelX = next.x;
			panelY = next.y;
		}

		function onUp(ev: PointerEvent) {
			draggingPanel = false;
			handle.releasePointerCapture(ev.pointerId);
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
			const next = clampPanel(panelX, panelY);
			panelX = next.x;
			panelY = next.y;
			savePanel();
		}

		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
		handle.addEventListener('pointercancel', onUp);
	}

	function selectBrush(next: (typeof BRUSHES)[number]) {
		brush = next.id;
		spacing = next.spacing;
		spacingOpen = false;
	}

	function onBrushChange(event: Event) {
		// SAFETY: bound to the brush <select> in the template, whose options are exactly the
		// BRUSHES ids; currentTarget is that select element, so its value is a BrushKind.
		const id = (event.currentTarget as HTMLSelectElement).value as BrushKind;
		const next = BRUSHES.find((item) => item.id === id);
		if (next) selectBrush(next);
	}

	function toggleSpacing() {
		spacingOpen = !spacingOpen;
	}

	function closeSpacing() {
		spacingOpen = false;
	}

	function toggleResizeMode() {
		resizeMode = !resizeMode;
		if (resizeMode) {
			spacingOpen = false;
			eyedropper = false;
		}
	}

	const toolBtn =
		'flex size-9 items-center justify-center rounded-md bg-[#2a2a2e] text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.35)] transition hover:bg-[#34343a] hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-[#2a2a2e] disabled:hover:text-white/70';
	const toolBtnOn =
		'flex size-9 items-center justify-center rounded-md bg-[#4a4a52] text-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.45),0_1px_0_rgba(255,255,255,0.06)]';
	const settingBtn =
		'flex h-7 items-center justify-center rounded bg-[#2a2a2e] px-2 text-[10px] font-medium whitespace-nowrap text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.35)] transition hover:bg-[#34343a] hover:text-white/90';
	const settingBtnOn =
		'flex h-7 items-center justify-center rounded bg-[#4a4a52] px-2 text-[10px] font-medium whitespace-nowrap text-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.45),0_1px_0_rgba(255,255,255,0.06)]';
	const toolSelect =
		'h-7 min-w-28 rounded border border-white/10 bg-[#2a2a2e] px-2 text-[11px] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.35)] outline-none focus:border-white/30';
</script>

<svelte:window
	onpointerdown={(e) => {
		if (!spacingOpen) return;
		const t = e.target;
		if (t instanceof Element && t.closest('[data-spacing-menu]')) return;
		closeSpacing();
	}}
/>

<PaintCanvas
	bind:color
	bind:size
	bind:opacity
	bind:spacing
	bind:brush
	bind:lassoOptions
	bind:pressureSize
	bind:pressureOpacity
	bind:canUndo
	bind:canRedo
	bind:historyApi
	bind:historyState
	bind:docW
	bind:docH
	bind:zoom
	bind:eyedropper
	bind:resizeMode
	bind:mirrorView
	suspended={historyOpen}
/>

{#if !resizeMode}
	<ColorPicker bind:color bind:picking={eyedropper} />

	<!-- Size + opacity rollers (draggable) -->
	{#if panelReady}
		<div
			bind:this={panelEl}
			class="fixed z-10 flex flex-col items-center gap-2"
			style:left="{panelX}px"
			style:top="{panelY}px"
		>
			<button
				type="button"
				class="flex h-5 w-full cursor-grab items-center justify-center rounded-md bg-[#2a2a2e] text-white/35 touch-none active:cursor-grabbing
					{draggingPanel ? 'cursor-grabbing bg-[#34343a]' : ''}"
				aria-label="Move sliders"
				title="Drag to move"
				onpointerdown={onPanelDragStart}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="currentColor"
					class="size-3.5"
					aria-hidden="true"
				>
					<circle cx="8" cy="8" r="1.5" />
					<circle cx="16" cy="8" r="1.5" />
					<circle cx="8" cy="16" r="1.5" />
					<circle cx="16" cy="16" r="1.5" />
				</svg>
			</button>
			{#if brush === 'pen' || brush === 'airbrush'}
				<SliderSize bind:value={size} {zoom} />
			{/if}
			<SliderOpacity bind:value={opacity} />
		</div>
	{/if}
{/if}

<!-- Tool controls -->
<div class="fixed top-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-1.5">
	{#if !resizeMode}
		<label class="flex items-center gap-1.5 rounded-md bg-[#1e1e22] p-1 text-[11px] text-white/60">
			<span class="pl-1">Tool</span>
			<select class={toolSelect} value={brush} aria-label="Tool" onchange={onBrushChange}>
			{#each BRUSHES as b (b.id)}
				<option value={b.id}>{b.label}</option>
			{/each}
			</select>
		</label>

		{#if brush === 'lasso'}
			<div class="flex flex-wrap gap-1" role="group" aria-label="Lasso settings">
				<label class="flex items-center gap-1.5 rounded-md bg-[#1e1e22] p-1 text-[11px] text-white/60">
					<span class="pl-1">Mode</span>
					<select
						class={toolSelect}
						value={lassoOptions.mode}
						aria-label="Lasso mode"
						onchange={(event) =>
							(lassoOptions = {
								...lassoOptions,
								mode: (event.currentTarget as HTMLSelectElement).value as LassoMode
							})}
					>
						{#each LASSO_MODES as m (m.id)}
							<option value={m.id}>{m.label}</option>
						{/each}
					</select>
				</label>
				<button
					type="button"
					class={lassoOptions.splat ? settingBtnOn : settingBtn}
					aria-pressed={lassoOptions.splat}
					onclick={() => (lassoOptions = { ...lassoOptions, splat: !lassoOptions.splat })}
				>
					Splat: {lassoOptions.splat ? 'On' : 'Off'}
				</button>
			</div>
		{:else if brush === 'pen' || brush === 'airbrush'}
			<div class="flex flex-wrap gap-1" role="group" aria-label="Brush settings">
				<button
					type="button"
					class={pressureSize ? settingBtnOn : settingBtn}
					aria-label={pressureSize ? 'Pressure controls size' : 'Fixed size'}
					aria-pressed={pressureSize}
					onclick={() => (pressureSize = !pressureSize)}
				>
					Size pressure: {pressureSize ? 'On' : 'Off'}
				</button>
				<button
					type="button"
					class={pressureOpacity ? settingBtnOn : settingBtn}
					aria-label={pressureOpacity ? 'Pressure controls opacity' : 'Fixed opacity'}
					aria-pressed={pressureOpacity}
					onclick={() => (pressureOpacity = !pressureOpacity)}
				>
					Opacity pressure: {pressureOpacity ? 'On' : 'Off'}
				</button>

				<div class="relative" data-spacing-menu>
					<button
						type="button"
						class={spacingOpen ? settingBtnOn : settingBtn}
						aria-label="Brush spacing"
						title="Spacing"
						aria-expanded={spacingOpen}
						aria-haspopup="dialog"
						onclick={toggleSpacing}
					>
						Spacing
					</button>

					{#if spacingOpen}
						<div
							class="absolute top-0 left-full z-20 ml-2 rounded-lg bg-[#1e1e22] p-2 shadow-[0_8px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]"
							role="dialog"
							aria-label="Brush spacing"
						>
							<SliderSpacing bind:value={spacing} />
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="flex flex-wrap gap-1">
			<button
				type="button"
				class={toolBtn}
				disabled={!canUndo}
				aria-label="Undo"
				title="Undo"
				onclick={() => historyApi?.undo()}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="size-4"
					aria-hidden="true"
				>
					<path d="M3 7v6h6" />
					<path d="M3 13a9 9 0 1 0 3-7.7L3 7" />
				</svg>
			</button>
			<button
				type="button"
				class={historyOpen ? toolBtnOn : toolBtn}
				aria-label="History"
				aria-pressed={historyOpen}
				title="History and timelapse"
				onclick={() => (historyOpen = !historyOpen)}
			>
				<span class="text-[11px] font-semibold">H</span>
			</button>
			<button
				type="button"
				class={toolBtn}
				disabled={!canRedo}
				aria-label="Redo"
				title="Redo"
				onclick={() => historyApi?.redo()}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="size-4"
					aria-hidden="true"
				>
					<path d="M21 7v6h-6" />
					<path d="M21 13a9 9 0 1 1-3-7.7L21 7" />
				</svg>
			</button>
			<button
				type="button"
				class={mirrorView ? toolBtnOn : toolBtn}
				aria-label="Mirror view"
				aria-pressed={mirrorView}
				title="Mirror view (M)"
				onclick={() => (mirrorView = !mirrorView)}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="size-4"
					aria-hidden="true"
				>
					<path d="M12 3v18" />
					<path d="M4 7l5 5-5 5" />
					<path d="M20 7l-5 5 5 5" />
				</svg>
			</button>
			<button
				type="button"
				class={toolBtn}
				aria-label="Canvas size"
				title="Canvas size ({docW}×{docH})"
				onclick={toggleResizeMode}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="size-4"
					aria-hidden="true"
				>
					<path d="M15 3h6v6" />
					<path d="M9 21H3v-6" />
					<path d="M21 3l-7 7" />
					<path d="M3 21l7-7" />
				</svg>
			</button>
		</div>
	{:else}
		<button
			type="button"
			class={toolBtnOn}
			aria-label="Exit canvas resize"
			title="Exit canvas resize"
			onclick={toggleResizeMode}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="size-4"
				aria-hidden="true"
			>
				<path d="M15 3h6v6" />
				<path d="M9 21H3v-6" />
				<path d="M21 3l-7 7" />
				<path d="M3 21l7-7" />
			</svg>
		</button>
	{/if}
</div>

{#if historyOpen}
	<HistoryGraphDialog
		api={historyApi}
		state={historyState}
		onClose={() => (historyOpen = false)}
	/>
{/if}
