<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';
	import SliderSize from '$lib/SliderSize.svelte';
	import SliderOpacity from '$lib/SliderOpacity.svelte';

	let color = $state('#1a6cff');
	let size = $state(8);
	let opacity = $state(1);
</script>

<PaintCanvas bind:color bind:size bind:opacity />

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
</div>
