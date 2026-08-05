<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';
	import SliderSize from '$lib/SliderSize.svelte';
	import SliderOpacity from '$lib/SliderOpacity.svelte';
	import SliderSpacing from '$lib/SliderSpacing.svelte';
	import type { BrushKind } from '$lib/gpuPaint';

	const BRUSHES: { id: BrushKind; label: string; spacing: number }[] = [
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
	let zoom = $state(1);

	function selectBrush(next: (typeof BRUSHES)[number]) {
		brush = next.id;
		spacing = next.spacing;
	}
</script>

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
	bind:zoom
/>

<div class="fixed top-4 right-4 z-10">
	<input
		type="color"
		name="color"
		id="color"
		bind:value={color}
		class="h-10 w-10 cursor-pointer appearance-none overflow-hidden rounded-full border-0 bg-transparent p-0 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
	/>
</div>

<div class="fixed top-4 left-4 z-10 flex flex-col gap-1">
	<div class="mb-1 flex flex-col gap-1" role="group" aria-label="Brush">
		{#each BRUSHES as b (b.id)}
			<button
				type="button"
				class="rounded-md px-2.5 py-1.5 text-left text-xs font-medium tracking-wide transition
					{brush === b.id
						? 'bg-white/40 text-black hover:bg-white/50'
						: 'bg-white/15 text-white/80 hover:bg-white/25'}"
				aria-pressed={brush === b.id}
				onclick={() => selectBrush(b)}
			>
				{b.label}
			</button>
		{/each}
	</div>
	{#if brush !== 'lasso'}
		<SliderSize bind:value={size} {zoom} />
		<SliderSpacing bind:value={spacing} />
	{/if}
	<SliderOpacity bind:value={opacity} />
	{#if brush !== 'lasso'}
		<button
			type="button"
			class="mt-1 rounded-md px-2.5 py-1.5 text-left text-xs font-medium tracking-wide text-white/80 transition
			{pressureSize ? 'bg-white/15 hover:bg-white/25' : 'bg-white/40 text-black hover:bg-white/50'}"
			aria-pressed={!pressureSize}
			onclick={() => (pressureSize = !pressureSize)}
		>
			{pressureSize ? 'Pressure → size' : 'Fixed size'}
		</button>
		<button
			type="button"
			class="rounded-md px-2.5 py-1.5 text-left text-xs font-medium tracking-wide text-white/80 transition
			{pressureOpacity ? 'bg-white/15 hover:bg-white/25' : 'bg-white/40 text-black hover:bg-white/50'}"
			aria-pressed={!pressureOpacity}
			onclick={() => (pressureOpacity = !pressureOpacity)}
		>
			{pressureOpacity ? 'Pressure → opacity' : 'Fixed opacity'}
		</button>
	{/if}
	<button
		type="button"
		class="mt-1 rounded-md bg-white/15 px-2.5 py-1.5 text-left text-xs font-medium tracking-wide text-white/80 transition hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/15"
		disabled={!canUndo}
		onclick={() => historyApi?.undo()}
	>
		Undo
	</button>
	<button
		type="button"
		class="rounded-md bg-white/15 px-2.5 py-1.5 text-left text-xs font-medium tracking-wide text-white/80 transition hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/15"
		disabled={!canRedo}
		onclick={() => historyApi?.redo()}
	>
		Redo
	</button>
</div>
