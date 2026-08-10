<script lang="ts">
	import RollerSlider from '$lib/RollerSlider.svelte';

	let {
		value = $bindable(0.005),
		min = 0.005,
		max = 0.5,
		step = 0.005
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
	} = $props();

	let previewing = $state(false);

	let spacingPx = $derived(value * 64);
	const dabCount = 5;
	const dabSize = 16;
</script>

<RollerSlider
	bind:value
	{min}
	{max}
	{step}
	orientation="horizontal"
	bind:previewing
	label="Brush spacing"
/>

{#if previewing}
	<div
		class="pointer-events-none fixed top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
		style:width="{(dabCount - 1) * spacingPx + dabSize}px"
		style:height="{dabSize}px"
		aria-hidden="true"
	>
		{#each { length: dabCount } as _, i (i)}
			<div
				class="absolute top-0 size-4 rounded-full border border-white/80 bg-white/80"
				style:left="{i * spacingPx}px"
			></div>
		{/each}
	</div>
{/if}
