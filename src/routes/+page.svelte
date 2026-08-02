<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';
	import SliderSize from '$lib/SliderSize.svelte';
	import SliderOpacity from '$lib/SliderOpacity.svelte';
	import SliderSpacing from '$lib/SliderSpacing.svelte';

	let color = $state('#1a6cff');
	let size = $state(8);
	let opacity = $state(1);
	let spacing = $state(0.06);
	let pressureSize = $state(true);
	let pressureOpacity = $state(false);
</script>

<PaintCanvas
	bind:color
	bind:size
	bind:opacity
	bind:spacing
	bind:pressureSize
	bind:pressureOpacity
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
	<SliderSize bind:value={size} />
	<SliderOpacity bind:value={opacity} />
	<SliderSpacing bind:value={spacing} />
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
</div>
