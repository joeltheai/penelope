<script lang="ts">
	import RollerSlider from '$lib/RollerSlider.svelte';

	let {
		value = $bindable(8),
		min = 1,
		max = 250,
		step = 1,
		zoom = 1,
		orientation = 'vertical'
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		zoom?: number;
		orientation?: 'horizontal' | 'vertical';
	} = $props();

	let previewing = $state(false);
</script>

<RollerSlider
	bind:value
	{min}
	{max}
	{step}
	{orientation}
	bind:previewing
	label="Brush size"
/>

{#if previewing}
	<div
		class="pointer-events-none fixed top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/80 bg-white/20"
		style:width="{value * 2 * zoom}px"
		style:height="{value * 2 * zoom}px"
		aria-hidden="true"
	></div>
{/if}
