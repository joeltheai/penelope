<script lang="ts">
	import {
		layoutHistoryGraph,
		refreshHistoryGraphEdges,
		type HistoryGraphCard,
		type HistoryGraphLayout
	} from '$lib/historyGraphLayout';
	import type { HistoryApi, HistoryGraphData, HistoryUiState } from '$lib/historyStore';

	let {
		api,
		state: historyState,
		onClose
	}: {
		api: HistoryApi | null;
		state: HistoryUiState;
		onClose: () => void;
	} = $props();

	const POSITION_KEY = 'penelope.historyGraph.positions.v3';
	const PANEL_HEIGHT_KEY = 'penelope.historyGraph.replayPanelHeight';
	let graph = $state<HistoryGraphData | null>(null);
	let layout = $state<HistoryGraphLayout | null>(null);
	let snapshotUrls = $state<Record<string, string>>({});
	let selectedCardId = $state<string | null>(null);
	let selectedBranchId = $state<string | null>(null);
	let loading = $state(true);
	let actionBusy = $state(false);
	let error = $state<string | null>(null);
	let previewCanvas = $state<HTMLCanvasElement>();
	let replayLoading = $state(false);
	let replayBranchId = $state<string | null>(null);
	let replayIndex = $state(0);
	let replayTotal = $state(0);
	let replayFps = $state(8);
	let exportResolution = $state<720 | 1280 | 1920>(1280);
	let renameText = $state('');
	let deleteConfirm = $state(false);
	let resetProjectConfirm = $state(false);
	let viewport = $state<HTMLElement>();
	let viewX = $state(0);
	let viewY = $state(0);
	let viewScale = $state(1);
	const activePointers = new Map<number, { x: number; y: number }>();
	let panPointerId: number | null = null;
	let panStart = { x: 0, y: 0, viewX: 0, viewY: 0 };
	let pinchStart:
		| { distance: number; scale: number; graphX: number; graphY: number }
		| null = null;
	let loadGeneration = 0;
	let replayLoadGeneration = 0;
	let scrubRaf = 0;
	let replayPanelHeight = $state(280);
	let panelResize:
		| { pointerId: number; startY: number; startHeight: number }
		| null = null;
	let drag:
		| {
				cardId: string;
				pointerId: number;
				startClientX: number;
				startClientY: number;
				startX: number;
				startY: number;
				moved: boolean;
		  }
		| null = null;
	let suppressClickFor: string | null = null;

	const selectedCard = $derived(
		layout?.cards.find((card) => card.id === selectedCardId) ?? null
	);
	const selectedBranch = $derived(
		graph?.branches.find((branch) => branch.id === selectedBranchId) ?? null
	);
	const selectedIsBranchTip = $derived(selectedCard?.kind === 'tip' && !!selectedBranch);

	function snapshotKey(nodeId: string | null) {
		return nodeId ?? '__root__';
	}

	function formatBytes(bytes: number) {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let value = bytes / 1024;
		let unit = units[0]!;
		for (let index = 1; index < units.length && value >= 1024; index++) {
			value /= 1024;
			unit = units[index]!;
		}
		return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${unit}`;
	}

	function revokeSnapshots() {
		for (const url of Object.values(snapshotUrls)) URL.revokeObjectURL(url);
		snapshotUrls = {};
	}

	function branchContainsNode(branchId: string, nodeId: string | null) {
		if (!graph || nodeId === null) return true;
		const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
		let id = graph.branches.find((branch) => branch.id === branchId)?.tipNodeId ?? null;
		while (id) {
			if (id === nodeId) return true;
			id = nodes.get(id)?.parentId ?? null;
		}
		return false;
	}

	function branchForCard(card: HistoryGraphCard) {
		if (card.branchId) return card.branchId;
		if (selectedBranchId && branchContainsNode(selectedBranchId, card.nodeId)) {
			return selectedBranchId;
		}
		return (
			graph?.branches.find((branch) => branchContainsNode(branch.id, card.nodeId))?.id ??
			graph?.activeBranchId ??
			null
		);
	}

	function selectCard(card: HistoryGraphCard) {
		if (suppressClickFor === card.id) return;
		api?.pauseReplay();
		selectedCardId = card.id;
		selectedBranchId = branchForCard(card);
		deleteConfirm = false;
		const branchId = selectedBranchId;
		requestAnimationFrame(() => {
			if (branchId) void prepareReplay(branchId, selectedIndex());
		});
	}

	function savedPositions() {
		try {
			// SAFETY: POSITION_KEY is only ever written by this dialog as { x, y } numbers;
			// JSON.parse returns `any`, so assert the stored shape.
			return JSON.parse(localStorage.getItem(POSITION_KEY) ?? '{}') as Record<
				string,
				{ x: number; y: number }
			>;
		} catch {
			return {};
		}
	}

	function applySavedPositions(nextLayout: HistoryGraphLayout) {
		const positions = savedPositions();
		for (const card of nextLayout.cards) {
			const position = positions[card.id];
			if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
			card.x = Math.max(20, position.x);
			card.y = Math.max(20, position.y);
		}
		nextLayout.width = Math.max(
			nextLayout.width,
			...nextLayout.cards.map((card) => card.x + card.width + 54)
		);
		nextLayout.height = Math.max(
			nextLayout.height,
			...nextLayout.cards.map((card) => card.y + card.height + 50)
		);
		refreshHistoryGraphEdges(nextLayout);
	}

	function saveCardPosition(card: HistoryGraphCard) {
		const positions = savedPositions();
		positions[card.id] = { x: Math.round(card.x), y: Math.round(card.y) };
		localStorage.setItem(POSITION_KEY, JSON.stringify(positions));
	}

	function resetLayout() {
		localStorage.removeItem(POSITION_KEY);
		void loadGraph();
	}

	function clampScale(scale: number) {
		return Math.max(0.12, Math.min(4, scale));
	}

	function setScaleAround(nextScale: number, clientX: number, clientY: number) {
		if (!viewport) return;
		const rect = viewport.getBoundingClientRect();
		const localX = clientX - rect.left;
		const localY = clientY - rect.top;
		const graphX = (localX - viewX) / viewScale;
		const graphY = (localY - viewY) / viewScale;
		viewScale = clampScale(nextScale);
		viewX = localX - graphX * viewScale;
		viewY = localY - graphY * viewScale;
	}

	function zoomBy(factor: number) {
		if (!viewport) return;
		const rect = viewport.getBoundingClientRect();
		setScaleAround(viewScale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
	}

	function fitGraph() {
		if (!viewport || !layout) return;
		const rect = viewport.getBoundingClientRect();
		const padding = 36;
		viewScale = clampScale(
			Math.min(
				(rect.width - padding * 2) / layout.width,
				(rect.height - padding * 2) / layout.height,
				1.4
			)
		);
		viewX = (rect.width - layout.width * viewScale) / 2;
		viewY = (rect.height - layout.height * viewScale) / 2;
	}

	function onViewportWheel(event: WheelEvent) {
		event.preventDefault();
		const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.002));
		setScaleAround(viewScale * factor, event.clientX, event.clientY);
	}

	function pointerPair() {
		return [...activePointers.values()].slice(0, 2);
	}

	function onViewportPointerDown(event: PointerEvent) {
		activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (activePointers.size === 2) {
			drag = null;
			const [a, b] = pointerPair();
			const rect = viewport!.getBoundingClientRect();
			const centerX = (a.x + b.x) / 2 - rect.left;
			const centerY = (a.y + b.y) / 2 - rect.top;
			pinchStart = {
				distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
				scale: viewScale,
				graphX: (centerX - viewX) / viewScale,
				graphY: (centerY - viewY) / viewScale
			};
			return;
		}
		// SAFETY: pointerdown targets on this surface are elements (buttons and the SVG
		// viewport); Element.closest requires an Element, not a Text node.
		const target = event.target as Element;
		if (!target.closest('button')) {
			panPointerId = event.pointerId;
			panStart = { x: event.clientX, y: event.clientY, viewX, viewY };
			viewport?.setPointerCapture(event.pointerId);
		}
	}

	function onViewportPointerMove(event: PointerEvent) {
		if (!activePointers.has(event.pointerId)) return;
		activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (activePointers.size >= 2 && pinchStart && viewport) {
			const [a, b] = pointerPair();
			const rect = viewport.getBoundingClientRect();
			const centerX = (a.x + b.x) / 2 - rect.left;
			const centerY = (a.y + b.y) / 2 - rect.top;
			viewScale = clampScale(
				pinchStart.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.distance)
			);
			viewX = centerX - pinchStart.graphX * viewScale;
			viewY = centerY - pinchStart.graphY * viewScale;
		} else if (panPointerId === event.pointerId) {
			viewX = panStart.viewX + event.clientX - panStart.x;
			viewY = panStart.viewY + event.clientY - panStart.y;
		}
	}

	function onViewportPointerUp(event: PointerEvent) {
		activePointers.delete(event.pointerId);
		if (panPointerId === event.pointerId) panPointerId = null;
		if (activePointers.size < 2) pinchStart = null;
	}

	function onCardPointerDown(event: PointerEvent, card: HistoryGraphCard) {
		if (event.button !== 0) return;
		// SAFETY: bound to a history card element in the template; currentTarget is that HTMLElement.
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = {
			cardId: card.id,
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startX: card.x,
			startY: card.y,
			moved: false
		};
	}

	function onCardPointerMove(event: PointerEvent, card: HistoryGraphCard) {
		if (!drag || drag.cardId !== card.id || drag.pointerId !== event.pointerId || !layout) return;
		if (activePointers.size > 1) return;
		const dx = (event.clientX - drag.startClientX) / viewScale;
		const dy = (event.clientY - drag.startClientY) / viewScale;
		if (Math.hypot(dx, dy) > 3) drag.moved = true;
		if (!drag.moved) return;
		card.x = Math.max(20, drag.startX + dx);
		card.y = Math.max(20, drag.startY + dy);
		layout.width = Math.max(layout.width, card.x + card.width + 54);
		layout.height = Math.max(layout.height, card.y + card.height + 50);
		refreshHistoryGraphEdges(layout);
	}

	function onCardPointerUp(event: PointerEvent, card: HistoryGraphCard) {
		if (!drag || drag.cardId !== card.id || drag.pointerId !== event.pointerId) return;
		if (drag.moved) {
			saveCardPosition(card);
			suppressClickFor = card.id;
			setTimeout(() => {
				if (suppressClickFor === card.id) suppressClickFor = null;
			}, 0);
		}
		drag = null;
	}

	async function loadGraph() {
		if (!api) return;
		const generation = ++loadGeneration;
		loading = true;
		error = null;
		try {
			const nextGraph = await api.getGraph();
			const nextLayout = layoutHistoryGraph(nextGraph);
			applySavedPositions(nextLayout);
			const snapshots = await api.getSnapshots(nextLayout.snapshotNodeIds);
			if (generation !== loadGeneration) return;
			revokeSnapshots();
			snapshotUrls = Object.fromEntries(
				snapshots.map((snapshot) => [
					snapshotKey(snapshot.nodeId),
					URL.createObjectURL(snapshot.blob)
				])
			);
			graph = nextGraph;
			layout = nextLayout;
			requestAnimationFrame(fitGraph);
			const preferredBranch =
				nextGraph.branches.find((branch) => branch.id === selectedBranchId) ??
				nextGraph.branches.find((branch) => branch.active) ??
				nextGraph.branches[0];
			selectedBranchId = preferredBranch?.id ?? null;
			selectedCardId =
				nextLayout.cards.find((card) => card.id === `tip:${selectedBranchId}`)?.id ??
				nextLayout.cards[0]?.id ??
				null;
			renameText = preferredBranch?.name ?? '';
			deleteConfirm = false;
			if (preferredBranch) {
				requestAnimationFrame(() => {
					if (generation === loadGeneration) {
						void prepareReplay(preferredBranch.id, selectedIndex());
					}
				});
			}
		} catch (caught) {
			if (generation !== loadGeneration) return;
			error = caught instanceof Error ? caught.message : 'Could not load history graph';
		} finally {
			if (generation === loadGeneration) loading = false;
		}
	}

	function selectedIndex() {
		if (!graph || !selectedBranchId || !selectedCard) return 0;
		const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
		const path: string[] = [];
		let id = graph.branches.find((branch) => branch.id === selectedBranchId)?.tipNodeId ?? null;
		while (id) {
			path.push(id);
			id = nodes.get(id)?.parentId ?? null;
		}
		path.reverse();
		if (selectedCard.nodeId === null) return 0;
		const index = path.indexOf(selectedCard.nodeId);
		return index < 0 ? path.length : index + 1;
	}

	async function runAction(action: () => Promise<void>) {
		if (actionBusy) return;
		actionBusy = true;
		error = null;
		try {
			closeReplay();
			await action();
			await loadGraph();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'History action failed';
		} finally {
			actionBusy = false;
		}
	}

	function openSelected() {
		if (!api || !selectedBranchId) return;
		void runAction(async () => {
			await api.switchBranch(selectedBranchId!);
			await api.seek(selectedIndex());
		});
	}

	function renameSelected() {
		if (!api || !selectedIsBranchTip || !selectedBranch) return;
		void runAction(() => api.renameBranch(selectedBranch.id, renameText));
	}

	function deleteSelected() {
		if (!api || !selectedIsBranchTip || !selectedBranch) return;
		if (!deleteConfirm) {
			deleteConfirm = true;
			return;
		}
		const branchId = selectedBranch.id;
		selectedBranchId = null;
		selectedCardId = null;
		void runAction(() => api.deleteBranch(branchId));
	}

	async function resetProject() {
		if (!api) return;
		if (!resetProjectConfirm) {
			resetProjectConfirm = true;
			return;
		}
		actionBusy = true;
		error = null;
		try {
			closeReplay();
			await api.resetProject();
			localStorage.removeItem(POSITION_KEY);
			resetProjectConfirm = false;
			onClose();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Could not reset project';
		} finally {
			actionBusy = false;
		}
	}

	async function prepareReplay(branchId: string, index: number) {
		if (!api) return;
		const generation = ++replayLoadGeneration;
		replayLoading = true;
		replayBranchId = branchId;
		replayIndex = 0;
		replayTotal = 0;
		error = null;
		try {
			if (!previewCanvas) throw new Error('Replay canvas is not ready');
			const replay = await api.openReplay(branchId, previewCanvas);
			if (generation !== replayLoadGeneration) return;
			replayTotal = replay.total;
			replayIndex = await api.seekReplay(index);
		} catch (caught) {
			if (generation !== replayLoadGeneration) return;
			error = caught instanceof Error ? caught.message : 'Preview failed';
		} finally {
			if (generation === replayLoadGeneration) replayLoading = false;
		}
	}

	function closeReplay() {
		replayLoadGeneration++;
		if (scrubRaf) {
			cancelAnimationFrame(scrubRaf);
			scrubRaf = 0;
		}
		api?.closeReplay();
		replayBranchId = null;
		replayIndex = 0;
		replayTotal = 0;
	}

	async function toggleReplay() {
		if (!api) return;
		if (historyState.replaying) {
			api.pauseReplay();
			return;
		}
		try {
			await api.playReplay({
				fps: replayFps,
				onFrame: (index) => (replayIndex = index)
			});
		} catch (caught) {
			error = caught instanceof Error ? caught.message : 'Replay failed';
		}
	}

	function scrubReplay(event: Event) {
		if (!api) return;
		api.pauseReplay();
		// SAFETY: bound to the replay scrubber <input type="range"> in the template, so
		// currentTarget is that input element and its value is a numeric index string.
		replayIndex = Number((event.currentTarget as HTMLInputElement).value);
		if (scrubRaf) cancelAnimationFrame(scrubRaf);
		scrubRaf = requestAnimationFrame(() => {
			scrubRaf = 0;
			void api
				?.seekReplay(replayIndex)
				.then((index) => (replayIndex = index))
				.catch((caught) => {
					error = caught instanceof Error ? caught.message : 'Could not seek replay';
				});
		});
	}

	function branchFromReplay() {
		if (!api || !replayBranchId) return;
		const branchId = replayBranchId;
		const index = replayIndex;
		if (scrubRaf) {
			cancelAnimationFrame(scrubRaf);
			scrubRaf = 0;
		}
		api.pauseReplay();
		replayBranchId = null;
		selectedBranchId = null;
		selectedCardId = null;
		void runAction(async () => {
			await api.switchBranch(branchId);
			await api.seek(index);
			await api.fork();
		});
	}

	function exportSelected() {
		if (!api || !selectedBranchId) return;
		void api.exportVideo({
			branchId: selectedBranchId,
			fps: replayFps,
			maxDimension: exportResolution
		});
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.code === 'Escape') onClose();
	}

	function onPanelResizeStart(event: PointerEvent) {
		if (event.button !== 0) return;
		// SAFETY: bound to the panel resize handle element in the template; currentTarget is that HTMLElement.
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		panelResize = {
			pointerId: event.pointerId,
			startY: event.clientY,
			startHeight: replayPanelHeight
		};
	}

	function onPanelResizeMove(event: PointerEvent) {
		if (!panelResize || panelResize.pointerId !== event.pointerId) return;
		const maxHeight = Math.max(220, window.innerHeight - 150);
		replayPanelHeight = Math.max(
			190,
			Math.min(maxHeight, panelResize.startHeight + panelResize.startY - event.clientY)
		);
	}

	function onPanelResizeEnd(event: PointerEvent) {
		if (!panelResize || panelResize.pointerId !== event.pointerId) return;
		panelResize = null;
		localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(replayPanelHeight)));
	}

	$effect(() => {
		if (selectedIsBranchTip && selectedBranch) renameText = selectedBranch.name;
	});

	$effect(() => {
		if (!api) return;
		const savedHeight = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
		if (Number.isFinite(savedHeight) && savedHeight >= 190) {
			replayPanelHeight = Math.min(savedHeight, Math.max(220, window.innerHeight - 150));
		}
		void loadGraph();
		return () => {
			loadGeneration++;
			if (scrubRaf) cancelAnimationFrame(scrubRaf);
			closeReplay();
			revokeSnapshots();
		};
	});
</script>

<svelte:window onkeydown={onKeyDown} />

<div
	class="fixed inset-0 z-100 flex flex-col bg-[#111114] text-white"
	role="dialog"
	aria-modal="true"
	aria-label="History graph"
>
	<header class="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3">
		<h2 class="text-sm font-semibold">History</h2>
		{#if graph}
			<span
				class="text-[10px] text-white/40"
				title={`Raw pixel payload: ${formatBytes(graph.storage.patchBytes)} history + ${formatBytes(graph.storage.baselineBytes)} baseline. Browser database overhead is additional.`}
			>
				{formatBytes(graph.storage.totalBytes)} stored pixels
			</span>
		{/if}
		<div class="ml-auto flex items-center gap-2">
			<button
				type="button"
				class="rounded-md bg-white/5 px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/10"
				onclick={resetLayout}
			>
				Auto layout
			</button>
			<button
				type="button"
				class="rounded-md px-2.5 py-1.5 text-xs {resetProjectConfirm
					? 'bg-red-500 text-white'
					: 'bg-red-500/10 text-red-300 hover:bg-red-500/20'}"
				disabled={actionBusy || historyState.busy}
				onclick={resetProject}
			>
				{resetProjectConfirm ? 'Confirm delete all' : 'Delete project'}
			</button>
			<button
				type="button"
				class="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
				onclick={() => {
					closeReplay();
					onClose();
				}}
			>
				Close
			</button>
		</div>
	</header>

	<section
		class="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-[#16161a] active:cursor-grabbing"
		role="application"
		aria-label="History graph. Drag to pan and pinch or scroll to zoom."
		bind:this={viewport}
		onwheel={onViewportWheel}
		onpointerdown={onViewportPointerDown}
		onpointermove={onViewportPointerMove}
		onpointerup={onViewportPointerUp}
		onpointercancel={onViewportPointerUp}
	>
		{#if loading}
			<div class="absolute inset-0 grid place-items-center text-sm text-white/45">
				Building history snapshots…
			</div>
		{:else if layout}
			<div
				data-graph-surface
				class="absolute top-0 left-0"
				style:width={`${layout.width}px`}
				style:height={`${layout.height}px`}
				style:transform={`translate(${viewX}px, ${viewY}px) scale(${viewScale})`}
				style:transform-origin="0 0"
			>
				<svg
					class="pointer-events-none absolute inset-0 overflow-visible"
					width={layout.width}
					height={layout.height}
					aria-hidden="true"
				>
					{#each layout.edges as edge (edge.id)}
						<path d={edge.path} fill="none" stroke="rgba(255,255,255,.2)" stroke-width="2" />
						{#if edge.label}
							<text
								x={edge.labelX}
								y={edge.labelY}
								text-anchor="middle"
								fill="rgba(255,255,255,.32)"
								font-size="9"
							>{edge.label}</text>
						{/if}
					{/each}
				</svg>

				{#each layout.cards as card (card.id)}
					<button
						data-graph-card
						type="button"
						class="absolute cursor-move touch-none overflow-hidden rounded-md border bg-[#24242a] text-left shadow-md
							{selectedCardId === card.id
								? 'border-blue-400 ring-1 ring-blue-400/30'
								: 'border-white/10 hover:border-white/30'}"
						aria-label={`${card.title}, ${card.subtitle}`}
						title={`${card.title} · ${card.subtitle}`}
						style:left={`${card.x}px`}
						style:top={`${card.y}px`}
						style:width={`${card.width}px`}
						style:height={`${card.height}px`}
						onpointerdown={(event) => onCardPointerDown(event, card)}
						onpointermove={(event) => onCardPointerMove(event, card)}
						onpointerup={(event) => onCardPointerUp(event, card)}
						onpointercancel={(event) => onCardPointerUp(event, card)}
						onclick={() => selectCard(card)}
					>
						<div class="absolute inset-0 bg-white/5">
							{#if snapshotUrls[snapshotKey(card.nodeId)]}
								<img
									class="h-full w-full object-contain"
									src={snapshotUrls[snapshotKey(card.nodeId)]}
									alt={`${card.title} snapshot`}
									draggable="false"
								/>
							{/if}
						</div>
						<span
							class="absolute right-1.5 bottom-1.5 size-2 rounded-full border border-black/40 shadow
									{card.kind === 'divergence'
										? 'bg-amber-300'
										: card.kind === 'tip'
											? 'bg-blue-400'
											: 'bg-white/35'}"
						></span>
					</button>
				{/each}
			</div>
		{/if}

		<div
			class="absolute right-3 bottom-3 flex overflow-hidden rounded-md border border-white/10 bg-[#24242a]/95 shadow-lg"
		>
			<button
				class="grid size-8 place-items-center text-sm hover:bg-white/10"
				type="button"
				aria-label="Zoom out"
				onclick={() => zoomBy(0.8)}
			>−</button>
			<button
				class="border-x border-white/10 px-2.5 text-[10px] text-white/55 hover:bg-white/10"
				type="button"
				onclick={fitGraph}
			>Fit</button>
			<button
				class="grid size-8 place-items-center text-sm hover:bg-white/10"
				type="button"
				aria-label="Zoom in"
				onclick={() => zoomBy(1.25)}
			>+</button>
		</div>
	</section>

	<footer
		class="relative flex shrink-0 flex-col border-t border-white/10 bg-[#1c1c21] px-3 pt-4 pb-3"
		style:height={`${replayPanelHeight}px`}
	>
		<div
			class="absolute top-0 right-0 left-0 z-10 flex h-3 cursor-ns-resize touch-none items-center justify-center hover:bg-white/5"
			role="separator"
			aria-label="Resize replay panel"
			aria-orientation="horizontal"
			onpointerdown={onPanelResizeStart}
			onpointermove={onPanelResizeMove}
			onpointerup={onPanelResizeEnd}
			onpointercancel={onPanelResizeEnd}
		>
			<div class="h-1 w-10 rounded-full bg-white/20"></div>
		</div>

		<div class="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[minmax(160px,1fr)_minmax(280px,430px)]">
		<div class="relative min-h-12 overflow-hidden rounded-md bg-black/35">
			<div class="absolute inset-0 flex items-center justify-center p-2">
				<canvas
					class="block max-h-full max-w-full bg-white shadow-lg"
					bind:this={previewCanvas}
				></canvas>
			</div>
			{#if replayLoading}
				<div class="absolute inset-0 grid place-items-center bg-black/30 text-xs text-white/65">
					Loading replay…
				</div>
			{/if}
		</div>

		<div class="min-h-0 overflow-y-auto pr-1">
		<div class="flex w-full flex-wrap items-center gap-2">
			<button
				type="button"
				class="w-16 rounded-md bg-blue-500 px-3 py-2 text-xs hover:bg-blue-400 disabled:opacity-40"
				disabled={replayLoading || replayTotal === 0}
				onclick={toggleReplay}
			>
				{historyState.replaying ? 'Pause' : replayIndex >= replayTotal ? 'Restart' : 'Play'}
			</button>
			<span class="w-20 text-center font-mono text-xs text-white/55">
				{replayIndex} / {replayTotal}
			</span>
			<input
				class="min-w-48 flex-1 accent-blue-400"
				type="range"
				min="0"
				max={replayTotal}
				step="1"
				value={replayIndex}
				disabled={replayLoading || !replayBranchId}
				aria-label="Replay position"
				oninput={scrubReplay}
			/>
			<select class="rounded-md bg-white/10 px-2 py-2 text-xs" bind:value={replayFps}>
				<option value={4}>4 fps</option>
				<option value={8}>8 fps</option>
				<option value={12}>12 fps</option>
				<option value={24}>24 fps</option>
			</select>
			<button
				type="button"
				class="rounded-md bg-emerald-500 px-4 py-2 text-xs font-medium hover:bg-emerald-400 disabled:opacity-40"
				disabled={replayLoading || actionBusy || !replayBranchId}
				onclick={branchFromReplay}
			>
				Branch from here
			</button>
		</div>

		<div class="mt-2 flex w-full flex-wrap items-center gap-1.5">
			<div class="mr-auto min-w-45">
				{#if selectedIsBranchTip}
					<div class="flex max-w-sm gap-1.5">
						<input
							class="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs outline-none focus:border-blue-400"
							aria-label="Branch name"
							maxlength="64"
							bind:value={renameText}
							onkeydown={(event) => {
								if (event.code === 'Enter') {
									event.stopPropagation();
									renameSelected();
								}
							}}
						/>
						<button
							type="button"
							class="rounded-md bg-white/10 px-2.5 text-xs hover:bg-white/15 disabled:opacity-40"
							disabled={actionBusy || !renameText.trim() || renameText.trim() === selectedBranch?.name}
							onclick={renameSelected}
						>
							Rename
						</button>
					</div>
				{:else}
					<span class="text-xs text-white/55">{selectedCard?.title ?? 'Choose a history node'}</span>
				{/if}
				{#if error || historyState.error}
					<p class="mt-1 text-[10px] text-red-300">{error ?? historyState.error}</p>
				{/if}
			</div>
			<button
				type="button"
				class="rounded-md bg-white/10 px-3 py-2 text-xs hover:bg-white/15 disabled:opacity-40"
				disabled={!selectedCard || actionBusy || historyState.busy}
				onclick={openSelected}
			>
				Go here
			</button>
			<select class="rounded-md bg-white/10 px-2 py-2 text-xs" bind:value={exportResolution}>
				<option value={720}>720p</option>
				<option value={1280}>1280p</option>
				<option value={1920}>1920p</option>
			</select>
			<button
				type="button"
				class="rounded-md bg-white/10 px-3 py-2 text-xs hover:bg-white/15 disabled:opacity-40"
				disabled={!selectedBranch || historyState.busy || selectedBranch.length === 0}
				onclick={exportSelected}
			>
				Export
			</button>
			{#if selectedIsBranchTip}
				<button
					type="button"
					class="rounded-md px-3 py-2 text-xs
						{deleteConfirm
							? 'bg-red-500 text-white'
							: 'bg-red-500/10 text-red-300 hover:bg-red-500/20'}"
					disabled={actionBusy || historyState.busy}
					onclick={deleteSelected}
				>
					{deleteConfirm ? 'Confirm delete' : 'Delete branch'}
				</button>
			{/if}
		</div>
		</div>
		</div>
	</footer>
</div>
