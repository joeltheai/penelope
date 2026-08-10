<script lang="ts">
	import RollerSlider from '$lib/RollerSlider.svelte';

	let {
		value = $bindable(1),
		min = 0.05,
		max = 1,
		step = 0.01,
		orientation = 'vertical'
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
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
	label="Brush opacity"
/>

{#if previewing}
	<div
		class="pointer-events-none fixed top-1/2 left-1/2 z-20 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-white"
		style:opacity={value}
		aria-hidden="true"
	></div>
{/if}
