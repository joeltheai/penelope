<script lang="ts">
	import PaintCanvas from '$lib/PaintCanvas.svelte';

	let color = $state('#1a6cff');
</script>

<PaintCanvas bind:color />

<div class="fixed top-4 right-4 z-10">
	<input
		type="color"
		name="color"
		id="color"
		bind:value={color}
		class="h-10 w-10 cursor-pointer appearance-none overflow-hidden rounded-full border-0 bg-transparent p-0 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
	/>
</div>
