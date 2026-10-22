<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';
	import ColorPicker from '$lib/ColorPicker.svelte';
	import Slider from '$lib/Slider.svelte';
	import {
		AIRBRUSH_PRESET,
		DEFAULT_BRUSH_SETTINGS,
		DEFAULT_DOC_W,
		DEFAULT_DOC_H,
		PEN_PRESET,
		type BrushBlend,
		type BrushSettings,
		type EditApi,
		type LassoMode,
		type LassoOptions,
		type ToolKind
	} from '$lib/gpuPaint';

	const TOOLS: { id: ToolKind; label: string }[] = [
		{ id: 'pen', label: 'Pen' },
		{ id: 'airbrush', label: 'Airbrush' },
		{ id: 'lasso', label: 'Lasso' },
		{ id: 'fan', label: 'Fan' },
		{ id: 'fanFade', label: 'Fan Fade' }
	];

	const LASSO_MODES: { id: LassoMode; label: string }[] = [
		{ id: 'fill', label: 'Fill' },
		{ id: 'pull', label: 'Pull-Shape' }
	];

	const BLEND_MODES: { id: BrushBlend; label: string; hint: string }[] = [
		{ id: 'wash', label: 'Wash', hint: 'Uniform coverage — opacity builds to the brush opacity' },
		{ id: 'buildup', label: 'Build', hint: 'Paint accumulates with each dab (airbrush)' }
	];

	const pan = (v: number) => `${Math.round(v * 100)}%`;
	const sizeLabel = (v: number) => `${Math.round(v * 2)} px`;

	let color = $state('#1a6cff');
	let brushSettings = $state<BrushSettings>({ ...DEFAULT_BRUSH_SETTINGS });
	let brush = $state<ToolKind>('pen');
	let lassoOptions = $state<LassoOptions>({
		mode: 'fill',
		splat: false
	});
	let canUndo = $state(false);
	let canRedo = $state(false);
	let editApi = $state<EditApi | null>(null);
	let docW = $state(DEFAULT_DOC_W);
	let docH = $state(DEFAULT_DOC_H);
	let zoom = $state(1);
	let eyedropper = $state(false);
	let resizeMode = $state(false);
	let mirrorView = $state(false);

	const PANEL_KEY = 'penelope.brushPanel';
	let panelX = $state(12);
	let panelY = $state(0);
	let panelReady = $state(false);
	let draggingPanel = $state(false);
	let panelEl: HTMLElement | undefined = $state();

	let isBrush = $derived(brush === 'pen' || brush === 'airbrush');

	$effect(() => {
		try {
			const raw = localStorage.getItem(PANEL_KEY);
			if (raw) {
				const saved = JSON.parse(raw) as { x: number; y: number };
				panelX = saved.x;
				panelY = saved.y;
			} else {
				panelY = Math.round(window.innerHeight / 2 - 210);
			}
		} catch {
			panelY = Math.round(window.innerHeight / 2 - 210);
		}
		panelReady = true;
	});

	function clampPanel(x: number, y: number) {
		const w = panelEl?.offsetWidth ?? 200;
		const h = panelEl?.offsetHeight ?? 320;
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

	function selectBrush(id: ToolKind) {
		brush = id;
		if (id === 'pen') brushSettings = { ...brushSettings, ...PEN_PRESET };
		else if (id === 'airbrush') brushSettings = { ...brushSettings, ...AIRBRUSH_PRESET };
	}

	function onBrushChange(event: Event) {
		selectBrush((event.currentTarget as HTMLSelectElement).value as ToolKind);
	}

	function toggleResizeMode() {
		resizeMode = !resizeMode;
		if (resizeMode) eyedropper = false;
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
	const panelBox =
		'w-[184px] rounded-lg bg-[#1e1e22] p-2 shadow-[0_8px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]';
</script>

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
/>

{#if !resizeMode}
	<ColorPicker bind:color bind:picking={eyedropper} />

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
				aria-label="Move brush panel"
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

			<div class={panelBox}>
				{#if isBrush}
					<div class="flex flex-col gap-1.5">
						<Slider
							bind:value={brushSettings.size}
							min={1}
							max={160}
							step={0.5}
							label="Size"
							format={sizeLabel}
						/>
						<Slider
							bind:value={brushSettings.opacity}
							min={0}
							max={1}
							step={0.01}
							label="Opacity"
							format={pan}
						/>
						<Slider
							bind:value={brushSettings.flow}
							min={0}
							max={1}
							step={0.01}
							label="Flow"
							format={pan}
							disabled={brushSettings.blend === 'wash'}
							title="Flow — applies in Build mode"
						/>
						<Slider
							bind:value={brushSettings.spacing}
							min={0.01}
							max={0.4}
							step={0.005}
							label="Spacing"
							format={pan}
						/>
						<Slider
							bind:value={brushSettings.hardness}
							min={0}
							max={1}
							step={0.01}
							label="Hardness"
							format={pan}
						/>
						<Slider
							bind:value={brushSettings.smoothing}
							min={0}
							max={1}
							step={0.01}
							label="Smoothing"
							format={pan}
						/>
						<Slider
							bind:value={brushSettings.jitter}
							min={0}
							max={1}
							step={0.01}
							label="Jitter"
							format={pan}
						/>
					</div>
				{:else}
					<Slider
						bind:value={brushSettings.opacity}
						min={0}
						max={1}
						step={0.01}
						label="Opacity"
						format={pan}
					/>
				{/if}
			</div>
		</div>
	{/if}
{/if}

<div class="fixed top-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col items-start gap-1.5">
	{#if !resizeMode}
		<label class="flex items-center gap-1.5 rounded-md bg-[#1e1e22] p-1 text-[11px] text-white/60">
			<span class="pl-1">Tool</span>
			<select class={toolSelect} value={brush} aria-label="Tool" onchange={onBrushChange}>
				{#each TOOLS as t (t.id)}
					<option value={t.id}>{t.label}</option>
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
		{:else if isBrush}
			<div class="flex flex-wrap gap-1" role="group" aria-label="Brush settings">
				<div class="flex overflow-hidden rounded shadow-[0_1px_2px_rgba(0,0,0,0.35)]">
					{#each BLEND_MODES as mode (mode.id)}
						<button
							type="button"
							class="h-7 px-2 text-[10px] font-medium whitespace-nowrap transition
								{brushSettings.blend === mode.id
								? 'bg-[#4a4a52] text-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)]'
								: 'bg-[#2a2a2e] text-white/70 hover:bg-[#34343a] hover:text-white/90'}"
							aria-pressed={brushSettings.blend === mode.id}
							title={mode.hint}
							onclick={() => (brushSettings.blend = mode.id)}
						>
							{mode.label}
						</button>
					{/each}
				</div>
				<button
					type="button"
					class={brushSettings.pressureSize ? settingBtnOn : settingBtn}
					aria-label={brushSettings.pressureSize ? 'Pressure controls size' : 'Fixed size'}
					aria-pressed={brushSettings.pressureSize}
					onclick={() => (brushSettings.pressureSize = !brushSettings.pressureSize)}
				>
					Size pressure: {brushSettings.pressureSize ? 'On' : 'Off'}
				</button>
				<button
					type="button"
					class={brushSettings.pressureOpacity ? settingBtnOn : settingBtn}
					aria-label={brushSettings.pressureOpacity ? 'Pressure controls opacity' : 'Fixed opacity'}
					aria-pressed={brushSettings.pressureOpacity}
					onclick={() => (brushSettings.pressureOpacity = !brushSettings.pressureOpacity)}
				>
					Opacity pressure: {brushSettings.pressureOpacity ? 'On' : 'Off'}
				</button>
			</div>
		{/if}

		<div class="flex flex-wrap gap-1">
			<button
				type="button"
				class={toolBtn}
				disabled={!canUndo}
				aria-label="Undo"
				title="Undo"
				onclick={() => editApi?.undo()}
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
				onclick={() => editApi?.redo()}
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
