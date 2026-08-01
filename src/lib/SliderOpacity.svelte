<script lang="ts">
	let {
		value = $bindable(1),
		min = 0.05,
		max = 1,
		step = 0.01
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
	} = $props();

	let previewing = $state(false);

	function showPreview() {
		previewing = true;
	}

	function hidePreview() {
		previewing = false;
	}
</script>

<label class="flex items-center py-3">
	<input
		type="range"
		aria-label="Brush opacity"
		{min}
		{max}
		{step}
		bind:value
		onpointerdown={showPreview}
		onpointerup={hidePreview}
		onpointercancel={hidePreview}
		onfocus={showPreview}
		onblur={hidePreview}
		class="h-6 w-32 cursor-pointer appearance-none bg-transparent
			[&::-webkit-slider-runnable-track]:h-1.5
			[&::-webkit-slider-runnable-track]:rounded-full
			[&::-webkit-slider-runnable-track]:bg-white/50
			[&::-webkit-slider-thumb]:relative
			[&::-webkit-slider-thumb]:-mt-1
			[&::-webkit-slider-thumb]:size-3.5
			[&::-webkit-slider-thumb]:appearance-none
			[&::-webkit-slider-thumb]:rounded-full
			[&::-webkit-slider-thumb]:bg-white
			[&::-moz-range-track]:h-1.5
			[&::-moz-range-track]:rounded-full
			[&::-moz-range-track]:bg-white/50
			[&::-moz-range-thumb]:size-3.5
			[&::-moz-range-thumb]:rounded-full
			[&::-moz-range-thumb]:border-0
			[&::-moz-range-thumb]:bg-white"
	/>
</label>

{#if previewing}
	<div
		class="pointer-events-none fixed top-1/2 left-1/2 z-20 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-white"
		style:opacity={value}
		aria-hidden="true"
	></div>
{/if}
