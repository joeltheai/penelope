<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';
	import ColorPicker from '$lib/ColorPicker.svelte';
	import SliderSize from '$lib/SliderSize.svelte';
	import SliderOpacity from '$lib/SliderOpacity.svelte';
	import SliderSpacing from '$lib/SliderSpacing.svelte';
	import { type BrushKind, DEFAULT_DOC_W, DEFAULT_DOC_H } from '$lib/gpuPaint';

	const BRUSHES: {
		id: BrushKind;
		label: string;
		spacing: number;
	}[] = [
		{ id: 'pen', label: 'Pen', spacing: 0.005 },
		{ id: 'airbrush', label: 'Airbrush', spacing: 0.08 },
		{ id: 'lasso', label: 'Lasso', spacing: 0.02 }
	];

	let color = $state('#1a6cff');
	let size = $state(8);
	let opacity = $state(1);
	let spacing = $state(0.005);
	let brush = $state<BrushKind>('pen');
	let pressureSize = $state(false);
	let pressureOpacity = $state(true);
	let canUndo = $state(false);
	let canRedo = $state(false);
	let historyApi = $state<null | { undo: () => void; redo: () => void }>(null);
	let docW = $state(DEFAULT_DOC_W);
	let docH = $state(DEFAULT_DOC_H);
	let zoom = $state(1);
	let spacingOpen = $state(false);
	let eyedropper = $state(false);
	let resizeMode = $state(false);
	let mirrorView = $state(false);

	const PANEL_KEY = 'penelope.sliderPanel';
	let panelX = $state(12);
	let panelY = $state(0);
	let panelReady = $state(false);
	let draggingPanel = $state(false);
	let panelEl: HTMLElement | undefined = $state();

	$effect(() => {
		if (typeof window === 'undefined') return;
		try {
			const raw = localStorage.getItem(PANEL_KEY);
			if (raw) {
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
	bind:pressureSize
	bind:pressureOpacity
	bind:canUndo
	bind:canRedo
	bind:historyApi
	bind:docW
	bind:docH
	bind:zoom
	bind:eyedropper
	bind:resizeMode
	bind:mirrorView
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
			{#if brush !== 'lasso'}
				<SliderSize bind:value={size} {zoom} />
			{/if}
			<SliderOpacity bind:value={opacity} />
		</div>
	{/if}
{/if}

<!-- Tool strip -->
<div class="fixed top-4 left-4 z-50 flex flex-col gap-1.5">
	{#if !resizeMode}
		<div class="flex gap-1" role="group" aria-label="Brush">
			{#each BRUSHES as b (b.id)}
				<button
					type="button"
					class={brush === b.id ? toolBtnOn : toolBtn}
					aria-label={b.label}
					title={b.label}
					aria-pressed={brush === b.id}
					onclick={() => selectBrush(b)}
				>
					{#if b.id === 'pen'}
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
							<path d="M4 20l4.5-1.5L19 8l-3-3L5.5 15.5 4 20z" />
							<path d="M14.5 6.5l3 3" />
						</svg>
					{:else if b.id === 'airbrush'}
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
							<path d="M12 14v7" />
							<path d="M9 21h6" />
							<path d="M12 14c2.5 0 4.5-2 4.5-4.5S14.5 5 12 5 7.5 7 7.5 9.5" />
							<path d="M7.5 9.5c-1.5.3-2.5 1.5-2.5 3 0 1.7 1.3 3 3 3h4" />
							<path d="M15 3v.01" />
							<path d="M18 5v.01" />
							<path d="M19 8v.01" />
						</svg>
					{:else}
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
							<path d="M7 22a5 5 0 0 1-2-4" />
							<path
								d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8a7.9 7.9 0 0 1-1.5 4.7"
							/>
							<path
								d="M5 18a4 4 0 0 0 4-4 1 1 0 0 1 1.5-.9 5.4 5.4 0 0 0 2.5.9 4 4 0 0 0 4-4"
							/>
						</svg>
					{/if}
				</button>
			{/each}
		</div>

		{#if brush !== 'lasso'}
			<div class="flex gap-1" role="group" aria-label="Pressure">
				<button
					type="button"
					class={!pressureSize ? toolBtnOn : toolBtn}
					aria-label={pressureSize ? 'Pressure controls size' : 'Fixed size'}
					title={pressureSize ? 'Pressure → size' : 'Fixed size'}
					aria-pressed={!pressureSize}
					onclick={() => (pressureSize = !pressureSize)}
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
						{#if pressureSize}
							<circle cx="12" cy="12" r="2.5" />
							<circle cx="12" cy="12" r="6" opacity="0.55" />
							<circle cx="12" cy="12" r="9.5" opacity="0.3" />
						{:else}
							<circle cx="12" cy="12" r="6" />
						{/if}
					</svg>
				</button>
				<button
					type="button"
					class={!pressureOpacity ? toolBtnOn : toolBtn}
					aria-label={pressureOpacity ? 'Pressure controls opacity' : 'Fixed opacity'}
					title={pressureOpacity ? 'Pressure → opacity' : 'Fixed opacity'}
					aria-pressed={!pressureOpacity}
					onclick={() => (pressureOpacity = !pressureOpacity)}
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
						<circle cx="12" cy="12" r="9" />
						{#if pressureOpacity}
							<path
								d="M12 3a9 9 0 0 1 0 18Z"
								fill="currentColor"
								opacity="0.25"
								stroke="none"
							/>
							<path
								d="M12 7a5 5 0 0 1 0 10Z"
								fill="currentColor"
								opacity="0.55"
								stroke="none"
							/>
						{:else}
							<path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" opacity="0.4" stroke="none" />
						{/if}
					</svg>
				</button>

				<div class="relative" data-spacing-menu>
					<button
						type="button"
						class={spacingOpen ? toolBtnOn : toolBtn}
						aria-label="Brush spacing"
						title="Spacing"
						aria-expanded={spacingOpen}
						aria-haspopup="dialog"
						onclick={toggleSpacing}
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
							<circle cx="5" cy="12" r="2.5" />
							<circle cx="12" cy="12" r="2.5" />
							<circle cx="19" cy="12" r="2.5" />
						</svg>
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

		<div class="flex gap-1">
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
