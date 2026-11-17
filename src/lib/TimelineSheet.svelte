<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type {
		HistoryApi,
		HistoryGraphData,
		HistoryNode,
		HistoryUiState
	} from '$lib/historyStore';

	const PREVIEW_W = 480;
	const PREVIEW_H = 360;
	const MAX_THUMBS = 18;
	const MAIN_BRANCH_ID = 'main';
	const PLAY_FPS = [8, 12, 24] as const;
	const EXPORT_FPS = [12, 24, 30] as const;
	const EXPORT_DIMENSIONS = [720, 1280, 1920] as const;

	type BranchView = {
		id: string;
		name: string;
		length: number;
		tipNodeId: string | null;
	};

	type TimelineThumb = {
		nodeId: string;
		index: number;
		url: string;
	};

	let {
		api,
		state: historyState,
		open,
		onclose
	}: {
		api: HistoryApi | null;
		state: HistoryUiState;
		open: boolean;
		onclose: () => void;
	} = $props();

	let graph = $state<HistoryGraphData | null>(null);
	let previewCanvas = $state<HTMLCanvasElement>();
	let loading = $state(false);
	let actionBusy = $state(false);
	let localError = $state<string | null>(null);
	let scrubIndex = $state(0);
	let replayTotal = $state(0);
	let playing = $state(false);
	let scrubbing = $state(false);
	let exportBusy = $state(false);
	let playFps = $state<number>(12);
	let exportFps = $state<number>(24);
	let exportDimension = $state<720 | 1280 | 1920>(1280);
	let renameBranchId = $state<string | null>(null);
	let renameText = $state('');
	let renameInput = $state<HTMLInputElement>();
	let deleteBranchId = $state<string | null>(null);
	let thumbs = $state<TimelineThumb[]>([]);
	let previewBranchId = $state<string | null>(null);

	let loadGen = 0;
	let graphGen = 0;
	let thumbUrls: string[] = [];
	let replayOpen = false;
	let seekGen = 0;
	let seekRaf = 0;
	let seekPump = false;
	let pendingSeek: number | null = null;
	let requestedSeek = -1;
	let disposeTimer: ReturnType<typeof setTimeout> | null = null;

	const branches: BranchView[] = $derived(graph?.branches ?? historyState.branches);
	const currentBranchId: string = $derived(graph?.activeBranchId ?? historyState.activeBranchId);
	const activeBranch = $derived(branches.find((branch) => branch.id === currentBranchId) ?? null);
	const total: number = $derived(
		previewBranchId === currentBranchId ? replayTotal : historyState.total
	);
	const shownIndex: number = $derived(Math.max(0, Math.min(total, scrubIndex)));
	const exportProgress: number | null = $derived(historyState.exportProgress);
	const isExporting: boolean = $derived(exportBusy || exportProgress !== null);
	const controlsBusy: boolean = $derived(actionBusy || historyState.busy || loading);
	const cannotSeek: boolean = $derived(controlsBusy || isExporting || total === 0 || !api);
	const playActive: boolean = $derived(playing || historyState.replaying);
	const errorText = $derived(localError ?? historyState.error);
	const pendingDelete = $derived(branches.find((branch) => branch.id === deleteBranchId) ?? null);
	const storageLabel: string = $derived(graph ? formatBytes(graph.storage.totalBytes) : '');
	const progressPct: number = $derived(exportPercent(exportProgress));
	const cursorPct: number = $derived(
		total > 0 ? (Math.max(0, Math.min(total, historyState.currentIndex)) / total) * 100 : 0
	);
	const cursorMarkerLeft: string = $derived(
		`calc(${cursorPct}% + ${9 - (cursorPct / 100) * 18}px)`
	);
	const scrubValueText: string = $derived(
		total === 0 ? 'No history yet' : `Stroke ${shownIndex} of ${total}`
	);

	$effect(() => {
		if (!open) return;
		const currentApi = api;
		if (!currentApi) return;
		const gen = ++loadGen;
		untrack(() => {
			void loadAll(currentApi, gen);
		});
		return () => {
			loadGen++;
			teardown();
		};
	});

	$effect(() => {
		const limit = total;
		if (!open) return;
		untrack(() => {
			if (scrubIndex > limit) scrubIndex = limit;
			else if (scrubIndex < 0) scrubIndex = 0;
		});
	});

	function formatBytes(bytes: number) {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		const rounded = unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
		return `${rounded} ${units[unit]}`;
	}

	function exportPercent(value: number | null) {
		if (value === null || !Number.isFinite(value)) return 0;
		const pct = value > 1.5 ? value : value * 100;
		return Math.max(0, Math.min(100, pct));
	}

	function isAbort(caught: unknown) {
		return caught instanceof DOMException && caught.name === 'AbortError';
	}

	function errorMessage(caught: unknown, fallback: string) {
		return caught instanceof Error && caught.message ? caught.message : fallback;
	}

	function branchPath(data: HistoryGraphData, branchId: string): HistoryNode[] {
		const nodes = new Map(data.nodes.map((node) => [node.id, node]));
		const branch = data.branches.find((candidate) => candidate.id === branchId);
		const path: HistoryNode[] = [];
		const seen = new Set<string>();
		let nodeId: string | null = branch?.tipNodeId ?? null;
		while (nodeId && !seen.has(nodeId)) {
			seen.add(nodeId);
			const node = nodes.get(nodeId);
			if (!node) break;
			path.push(node);
			nodeId = node.parentId;
		}
		return path.reverse();
	}

	function cursorIndex(data: HistoryGraphData) {
		const path = branchPath(data, data.activeBranchId);
		if (!data.cursorNodeId) return 0;
		const index = path.findIndex((node) => node.id === data.cursorNodeId);
		return index < 0 ? path.length : index + 1;
	}

	async function loadAll(currentApi: HistoryApi, gen: number) {
		loading = true;
		localError = null;
		try {
			await tick();
			if (gen !== loadGen) return;
			const next = await currentApi.getGraph();
			if (gen !== loadGen) return;
			graph = next;
			await openReplayFor(next, gen, currentApi);
			if (gen !== loadGen) return;
			void loadThumbs(next, gen, currentApi);
		} catch (caught) {
			if (gen !== loadGen || isAbort(caught)) return;
			localError = errorMessage(caught, 'Could not load history');
		} finally {
			if (gen === loadGen) loading = false;
		}
	}

	async function reloadAll(currentApi: HistoryApi) {
		const gen = ++loadGen;
		await loadAll(currentApi, gen);
	}

	async function openReplayFor(next: HistoryGraphData, gen: number, currentApi: HistoryApi) {
		if (!previewCanvas) throw new Error('Timeline preview is not ready');
		releaseReplay();
		const replay = await currentApi.openReplay(next.activeBranchId, previewCanvas);
		if (gen !== loadGen) return;
		replayOpen = true;
		previewBranchId = next.activeBranchId;
		replayTotal = replay.total;
		const start = Math.max(0, Math.min(replay.total, cursorIndex(next)));
		const actual = await currentApi.seekReplay(start);
		if (gen !== loadGen) return;
		scrubIndex = actual;
	}

	async function loadThumbs(next: HistoryGraphData, gen: number, currentApi: HistoryApi) {
		revokeThumbs();
		const path = branchPath(next, next.activeBranchId);
		const count = Math.min(MAX_THUMBS, path.length);
		if (count === 0) return;
		const indices = Array.from({ length: count }, (_, offset) =>
			count === 1 ? path.length - 1 : Math.round((offset * (path.length - 1)) / (count - 1))
		);
		const nodeIds = [...new Set(indices)].map((index) => path[index]!.id);
		try {
			const snapshots = await currentApi.getSnapshots(nodeIds);
			if (gen !== loadGen) return;
			const frames: TimelineThumb[] = [];
			for (const snapshot of snapshots) {
				if (!snapshot.nodeId) continue;
				const index = path.findIndex((node) => node.id === snapshot.nodeId) + 1;
				if (index <= 0) continue;
				frames.push({
					nodeId: snapshot.nodeId,
					index,
					url: URL.createObjectURL(snapshot.blob)
				});
			}
			for (const url of thumbUrls) URL.revokeObjectURL(url);
			thumbUrls = frames.map((frame) => frame.url);
			thumbs = frames;
		} catch {
			// Thumbnails are a progressive enhancement; the scrubber still works without them.
		}
	}

	function revokeThumbs() {
		for (const url of thumbUrls) URL.revokeObjectURL(url);
		thumbUrls = [];
		thumbs = [];
	}

	function pausePlayback() {
		playing = false;
		if (api && replayOpen) api.pauseReplay();
	}

	function releaseReplay() {
		if (seekRaf) {
			cancelAnimationFrame(seekRaf);
			seekRaf = 0;
		}
		seekGen++;
		pendingSeek = null;
		requestedSeek = -1;
		if (replayOpen) {
			api?.pauseReplay();
			api?.closeReplay();
			replayOpen = false;
		}
		previewBranchId = null;
		playing = false;
		scrubbing = false;
	}

	function stopWork() {
		loadGen++;
		graphGen++;
		seekGen++;
		if (seekRaf) {
			cancelAnimationFrame(seekRaf);
			seekRaf = 0;
		}
		pendingSeek = null;
		requestedSeek = -1;
		releaseReplay();
		playing = false;
		scrubbing = false;
	}

	function teardown() {
		stopWork();
		const gen = loadGen;
		if (disposeTimer !== null) clearTimeout(disposeTimer);
		// Keep the last frame and thumbnails on screen while the sheet slides out.
		disposeTimer = setTimeout(() => {
			disposeTimer = null;
			if (gen !== loadGen) return;
			revokeThumbs();
			graph = null;
			replayTotal = 0;
			scrubIndex = 0;
			loading = false;
			actionBusy = false;
			renameBranchId = null;
			deleteBranchId = null;
			localError = null;
		}, 200);
	}

	function requestClose() {
		stopWork();
		onclose();
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open || event.key !== 'Escape') return;
		if (renameBranchId) {
			event.stopPropagation();
			renameBranchId = null;
			return;
		}
		if (deleteBranchId) {
			event.stopPropagation();
			deleteBranchId = null;
			return;
		}
		requestClose();
	}

	function queueSeek(index: number) {
		if (!api) return;
		pendingSeek = index;
		requestedSeek = index;
		if (seekRaf) cancelAnimationFrame(seekRaf);
		seekRaf = requestAnimationFrame(() => {
			seekRaf = 0;
			void pumpSeek();
		});
	}

	async function pumpSeek() {
		if (!api || seekPump) return;
		seekPump = true;
		try {
			while (pendingSeek !== null) {
				const target = pendingSeek;
				pendingSeek = null;
				const gen = seekGen;
				try {
					const actual = await api.seekReplay(target);
					if (gen !== seekGen) return;
					if (target === requestedSeek) scrubIndex = actual;
				} catch (caught) {
					if (gen !== seekGen || isAbort(caught)) return;
					localError = errorMessage(caught, 'Could not seek replay');
					return;
				}
			}
		} finally {
			seekPump = false;
			if (pendingSeek !== null) {
				if (seekRaf) cancelAnimationFrame(seekRaf);
				seekRaf = requestAnimationFrame(() => {
					seekRaf = 0;
					void pumpSeek();
				});
			}
		}
	}

	function onScrubStart() {
		scrubbing = true;
		pausePlayback();
	}

	function onScrubInput(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		if (!Number.isFinite(value)) return;
		scrubIndex = value;
		queueSeek(value);
	}

	function onScrubEnd() {
		if (!scrubbing) return;
		scrubbing = false;
		queueSeek(scrubIndex);
	}

	function jumpTo(index: number) {
		if (!api || cannotSeek) return;
		pausePlayback();
		scrubIndex = index;
		queueSeek(index);
	}

	async function togglePlayback() {
		if (!api || cannotSeek) return;
		if (playActive) {
			pausePlayback();
			return;
		}
		localError = null;
		const gen = loadGen;
		try {
			let start = shownIndex;
			if (start >= total) start = 0;
			const actual = await api.seekReplay(start);
			if (gen !== loadGen) return;
			scrubIndex = actual;
			playing = true;
			await api.playReplay({
				fps: playFps,
				onFrame: (index) => {
					if (gen === loadGen) scrubIndex = index;
				}
			});
		} catch (caught) {
			if (gen === loadGen && !isAbort(caught)) {
				localError = errorMessage(caught, 'Could not play replay');
			}
		} finally {
			if (gen === loadGen) playing = false;
		}
	}

	function onPlayFpsChange(event: Event) {
		const value = Number((event.currentTarget as HTMLSelectElement).value);
		if ((PLAY_FPS as readonly number[]).includes(value)) playFps = value;
	}

	function onExportFpsChange(event: Event) {
		const value = Number((event.currentTarget as HTMLSelectElement).value);
		if ((EXPORT_FPS as readonly number[]).includes(value)) exportFps = value;
	}

	function onExportDimensionChange(event: Event) {
		const value = Number((event.currentTarget as HTMLSelectElement).value);
		if (value === 720 || value === 1280 || value === 1920) exportDimension = value;
	}

	async function restoreHere() {
		if (!api || cannotSeek) return;
		const index = shownIndex;
		actionBusy = true;
		localError = null;
		pausePlayback();
		releaseReplay();
		try {
			await api.seek(index);
			stopWork();
			onclose();
		} catch (caught) {
			if (!isAbort(caught)) localError = errorMessage(caught, 'Could not restore history');
		} finally {
			actionBusy = false;
		}
	}

	async function branchHere() {
		if (!api || cannotSeek) return;
		const index = shownIndex;
		actionBusy = true;
		localError = null;
		pausePlayback();
		releaseReplay();
		try {
			await api.seek(index);
			await api.fork();
			await reloadAll(api);
		} catch (caught) {
			if (!isAbort(caught)) localError = errorMessage(caught, 'Could not branch history');
		} finally {
			actionBusy = false;
		}
	}

	async function selectBranch(branchId: string) {
		if (!api || controlsBusy || branchId === currentBranchId) return;
		actionBusy = true;
		localError = null;
		pausePlayback();
		releaseReplay();
		renameBranchId = null;
		deleteBranchId = null;
		try {
			await api.switchBranch(branchId);
			await reloadAll(api);
		} catch (caught) {
			if (!isAbort(caught)) localError = errorMessage(caught, 'Could not switch branch');
		} finally {
			actionBusy = false;
		}
	}

	function onBranchClick(event: MouseEvent, branch: BranchView) {
		if (event.detail > 1) return;
		void selectBranch(branch.id);
	}

	async function addBranch() {
		if (!api || controlsBusy) return;
		actionBusy = true;
		localError = null;
		pausePlayback();
		try {
			await api.fork();
			await reloadAll(api);
		} catch (caught) {
			if (!isAbort(caught)) localError = errorMessage(caught, 'Could not add branch');
		} finally {
			actionBusy = false;
		}
	}

	function beginRename(branch: BranchView) {
		if (controlsBusy) return;
		renameBranchId = branch.id;
		renameText = branch.name;
		deleteBranchId = null;
		localError = null;
		void tick().then(() => {
			renameInput?.focus();
			renameInput?.select();
		});
	}

	function cancelRename() {
		renameBranchId = null;
		renameText = '';
	}

	async function submitRename(event: SubmitEvent) {
		event.preventDefault();
		if (!api || !renameBranchId || controlsBusy) return;
		const name = renameText.trim();
		if (!name) {
			localError = 'Branch name cannot be empty';
			return;
		}
		const branchId = renameBranchId;
		actionBusy = true;
		localError = null;
		try {
			await api.renameBranch(branchId, name);
			renameBranchId = null;
			await refreshGraph(api);
		} catch (caught) {
			if (!isAbort(caught)) localError = errorMessage(caught, 'Could not rename branch');
		} finally {
			actionBusy = false;
		}
	}

	async function refreshGraph(currentApi: HistoryApi) {
		const gen = ++graphGen;
		const next = await currentApi.getGraph();
		if (gen !== graphGen) return;
		graph = next;
	}

	function beginDelete(branch: BranchView) {
		if (controlsBusy || branch.id === MAIN_BRANCH_ID) return;
		deleteBranchId = branch.id;
		renameBranchId = null;
		localError = null;
	}

	async function confirmDelete() {
		const branchId = deleteBranchId;
		if (!api || !branchId || controlsBusy) return;
		actionBusy = true;
		localError = null;
		pausePlayback();
		releaseReplay();
		try {
			await api.deleteBranch(branchId);
			deleteBranchId = null;
			await reloadAll(api);
		} catch (caught) {
			if (!isAbort(caught)) localError = errorMessage(caught, 'Could not delete branch');
		} finally {
			actionBusy = false;
		}
	}

	async function exportVideo() {
		if (!api || controlsBusy || isExporting) return;
		localError = null;
		pausePlayback();
		exportBusy = true;
		try {
			await api.exportVideo({
				fps: exportFps,
				maxDimension: exportDimension,
				branchId: currentBranchId
			});
		} catch (caught) {
			if (!isAbort(caught)) localError = errorMessage(caught, 'Could not export video');
		} finally {
			exportBusy = false;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="timeline-layer" class:is-open={open} aria-hidden={!open}>
	<div class="timeline-sheet" role="dialog" aria-modal="false" aria-label="Timeline" inert={!open}>
		<div class="sheet-grip" aria-hidden="true"><span></span></div>

		<header class="sheet-head">
			<div class="head-copy">
				<h2 class="sheet-title pl-caps">Timeline</h2>
				{#if graph}
					<p class="sheet-meta">
						<span class="pl-mono">{activeBranch?.length ?? total} strokes</span>
						<span aria-hidden="true">·</span>
						<span class="pl-mono">{branches.length} branches</span>
						{#if storageLabel}
							<span aria-hidden="true">·</span>
							<span
								class="pl-mono storage"
								title={`Raw pixel payload: ${formatBytes(graph.storage.patchBytes)} history + ${formatBytes(graph.storage.baselineBytes)} baseline. Browser storage overhead is additional.`}
							>
								{storageLabel}
							</span>
						{/if}
					</p>
				{:else if !api}
					<p class="sheet-meta"><span class="pl-mono">History is unavailable</span></p>
				{:else}
					<p class="sheet-meta"><span class="pl-mono">Reading history…</span></p>
				{/if}
			</div>
			<button class="icon-button" type="button" aria-label="Close timeline" onclick={requestClose}>
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
					<path
						d="M6 6l12 12M18 6L6 18"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
					/>
				</svg>
			</button>
		</header>

		<div class="sheet-body">
			<div class="branch-row" role="group" aria-label="History branches">
				{#each branches as branch (branch.id)}
					<div class="branch-cell">
						<button
							type="button"
							class="branch-chip"
							class:active={branch.id === currentBranchId}
							aria-pressed={branch.id === currentBranchId}
							title={`${branch.name} · ${branch.length} strokes`}
							disabled={controlsBusy}
							onclick={(event) => onBranchClick(event, branch)}
							ondblclick={() => beginRename(branch)}
						>
							<span class="branch-name">{branch.name}</span>
							<span class="branch-count pl-mono">{branch.length}</span>
						</button>
						{#if branch.id === currentBranchId}
							<button
								type="button"
								class="branch-action"
								aria-label={`Rename ${branch.name}`}
								title="Rename branch"
								disabled={controlsBusy}
								onclick={() => beginRename(branch)}
							>
								<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
									<path
										d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"
										fill="none"
										stroke="currentColor"
										stroke-width="1.6"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</button>
							{#if branch.id !== MAIN_BRANCH_ID}
								<button
									type="button"
									class="branch-action danger"
									aria-label={`Delete ${branch.name}`}
									title="Delete branch"
									disabled={controlsBusy}
									onclick={() => beginDelete(branch)}
								>
									<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
										<path
											d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10 11v5M14 11v5"
											fill="none"
											stroke="currentColor"
											stroke-width="1.6"
											stroke-linecap="round"
										/>
									</svg>
								</button>
							{/if}
						{/if}
					</div>
				{/each}
				<button
					type="button"
					class="branch-add"
					disabled={controlsBusy || !api}
					onclick={addBranch}
				>
					+ Branch
				</button>
			</div>

			{#if renameBranchId}
				<form class="inline-row" onsubmit={submitRename}>
					<label>
						<span class="pl-sr">Branch name</span>
						<input
							class="text-field"
							bind:this={renameInput}
							bind:value={renameText}
							maxlength="64"
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
					<button
						class="action primary"
						type="submit"
						disabled={controlsBusy || !renameText.trim()}
					>
						Save
					</button>
					<button class="action" type="button" onclick={cancelRename}>Cancel</button>
				</form>
			{/if}

			{#if deleteBranchId}
				<div class="inline-row" role="group" aria-label="Confirm branch deletion">
					<span class="confirm-text">
						Delete <strong>{pendingDelete?.name ?? 'this branch'}</strong> and its strokes?
					</span>
					<button class="action danger" type="button" disabled={controlsBusy} onclick={confirmDelete}>
						Delete
					</button>
					<button class="action" type="button" onclick={() => (deleteBranchId = null)}>Keep</button>
				</div>
			{/if}

			<div class="timeline-main">
				<div class="preview-wrap">
					<canvas
						bind:this={previewCanvas}
						width={PREVIEW_W}
						height={PREVIEW_H}
						class="preview-canvas"
						aria-hidden="true"
					></canvas>
					{#if !api}
						<div class="preview-note">History is unavailable</div>
					{:else if loading || (!historyState.ready && !graph)}
						<div class="preview-note">Loading preview…</div>
					{:else if total === 0}
						<div class="preview-note empty">Paint a stroke to start history</div>
					{/if}
				</div>

				<div class="replay-controls">
					<div class="readout">
						<span class="pl-mono readout-index">{shownIndex} / {total}</span>
						<span>stroke</span>
						{#if historyState.cursorNodeId}
							<span class="cursor-readout">saved at {historyState.currentIndex}</span>
						{/if}
					</div>

					<div class="scrub-wrap">
						<input
							class="scrub"
							type="range"
							min="0"
							max={Math.max(total, 1)}
							step="1"
							value={shownIndex}
							disabled={cannotSeek}
							aria-label="History position"
							aria-valuetext={scrubValueText}
							onpointerdown={onScrubStart}
							onpointerup={onScrubEnd}
							onpointercancel={onScrubEnd}
							oninput={onScrubInput}
						/>
						<span
							class="cursor-marker"
							style={`left:${cursorMarkerLeft}`}
							aria-hidden="true"
							title="Saved history position"
						></span>
					</div>

					<div class="replay-buttons">
						<button
							class="action play"
							type="button"
							aria-pressed={playActive}
							aria-label={playActive ? 'Pause replay' : 'Play replay'}
							disabled={cannotSeek}
							onclick={togglePlayback}
						>
							{#if playActive}
								<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
									<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
									<rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
								</svg>
							{:else}
								<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
									<path d="M8 5v14l11-7z" fill="currentColor" />
								</svg>
							{/if}
						</button>

						<select
							class="select"
							aria-label="Replay frames per second"
							value={playFps}
							disabled={cannotSeek}
							onchange={onPlayFpsChange}
						>
							{#each PLAY_FPS as fps (fps)}
								<option value={fps}>{fps} fps</option>
							{/each}
						</select>

						<button class="action grow" type="button" disabled={cannotSeek} onclick={restoreHere}>
							Restore here
						</button>
						<button class="action grow" type="button" disabled={cannotSeek} onclick={branchHere}>
							Branch here
						</button>
					</div>
				</div>
			</div>

			{#if thumbs.length > 0}
				<div class="thumbs" role="group" aria-label="History snapshots">
					{#each thumbs as frame (frame.nodeId)}
						<button
							type="button"
							class="thumb"
							class:current={frame.index === shownIndex}
							aria-label={`Jump to stroke ${frame.index}`}
							aria-current={frame.index === shownIndex ? 'true' : undefined}
							disabled={cannotSeek}
							onclick={() => jumpTo(frame.index)}
						>
							<img src={frame.url} alt="" loading="lazy" />
						</button>
					{/each}
				</div>
			{/if}

			<div class="export-row">
				<div class="export-fields">
					<select
						class="select"
						aria-label="Export frames per second"
						value={exportFps}
						disabled={controlsBusy || isExporting}
						onchange={onExportFpsChange}
					>
						{#each EXPORT_FPS as fps (fps)}
							<option value={fps}>{fps} fps</option>
						{/each}
					</select>
					<select
						class="select"
						aria-label="Export maximum dimension"
						value={exportDimension}
						disabled={controlsBusy || isExporting}
						onchange={onExportDimensionChange}
					>
						{#each EXPORT_DIMENSIONS as dimension (dimension)}
							<option value={dimension}>{dimension} px</option>
						{/each}
					</select>
				</div>
				<button
					class="action primary export"
					type="button"
					aria-label="Export MP4 video"
					disabled={cannotSeek}
					onclick={exportVideo}
				>
					{isExporting ? 'Exporting…' : 'Export MP4'}
				</button>
			</div>

			{#if isExporting}
				<div
					class="progress"
					role="progressbar"
					aria-label="Video export progress"
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={Math.round(progressPct)}
				>
					<span style={`width:${progressPct}%`}></span>
				</div>
			{/if}

			{#if errorText}
				<p class="error" role="alert">{errorText}</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.timeline-layer {
		position: fixed;
		top: 0;
		left: var(--pl-tools);
		right: var(--pl-props);
		bottom: var(--pl-bar);
		z-index: 45;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		pointer-events: none;
		visibility: visible;
		transition: visibility 0s;
	}

	.timeline-layer:not(.is-open) {
		visibility: hidden;
		transition: visibility 0s linear 160ms;
	}

	.timeline-sheet {
		pointer-events: auto;
		position: relative;
		display: flex;
		flex-direction: column;
		width: 100%;
		max-height: min(60vh, 540px);
		background: var(--pl-dock);
		color: var(--pl-ink);
		border: 1px solid var(--pl-line);
		border-bottom: 0;
		border-radius: 0;
		padding-bottom: env(safe-area-inset-bottom);
		transform: translateY(0);
		opacity: 1;
		transition:
			transform 160ms var(--pl-ease),
			opacity 160ms var(--pl-ease);
		will-change: transform;
	}

	.timeline-layer:not(.is-open) .timeline-sheet {
		transform: translateY(calc(100% + 16px));
		opacity: 0;
		pointer-events: none;
	}

	.sheet-grip {
		display: grid;
		place-items: center;
		height: 12px;
		flex: none;
	}

	.sheet-grip span {
		width: 40px;
		height: 4px;
		border-radius: 2px;
		background: var(--pl-line-strong);
	}

	.sheet-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--pl-tap);
		padding: 0 var(--pl-gutter);
		border-bottom: 1px solid var(--pl-line);
		background: var(--pl-head-bg);
		flex: none;
	}

	.head-copy {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 1px;
	}

	.sheet-title {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0;
		text-transform: none;
		color: var(--pl-ink);
	}

	.sheet-meta {
		margin: 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 10px;
		color: var(--pl-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sheet-meta .storage {
		color: var(--pl-faint);
	}

	.icon-button {
		display: grid;
		place-items: center;
		width: var(--pl-tap);
		height: var(--pl-tap);
		flex: none;
		border: 1px solid transparent;
		border-radius: var(--pl-radius-sm);
		background: transparent;
		color: var(--pl-dim);
	}

	.icon-button:hover {
		background: var(--pl-hover);
		color: var(--pl-ink);
	}

	.sheet-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px var(--pl-gutter) 10px;
		scrollbar-width: none;
	}

	.sheet-body::-webkit-scrollbar {
		display: none;
	}

	.branch-row {
		display: flex;
		align-items: center;
		gap: 6px;
		overflow-x: auto;
		touch-action: pan-x;
		padding: 1px 0;
		scrollbar-width: none;
		flex: none;
	}

	.branch-row::-webkit-scrollbar {
		display: none;
	}

	.branch-cell {
		display: flex;
		align-items: center;
		gap: 2px;
		flex: none;
	}

	.branch-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: var(--pl-tap);
		max-width: 180px;
		padding: 0 12px;
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius-sm);
		background: var(--pl-panel);
		color: var(--pl-dim);
		font-size: 12px;
	}

	.branch-chip:hover:not(:disabled) {
		background: var(--pl-hover);
		color: var(--pl-ink);
	}

	.branch-chip.active {
		color: var(--pl-accent);
		background: var(--pl-accent-soft);
		border-color: var(--pl-accent);
	}

	.branch-chip.active:hover:not(:disabled) {
		background: var(--pl-accent-soft);
	}

	.branch-chip:disabled {
		opacity: 0.5;
	}

	.branch-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.branch-count {
		font-size: 10px;
		color: var(--pl-faint);
	}

	.branch-chip.active .branch-count {
		color: var(--pl-dim);
	}

	.branch-action {
		display: grid;
		place-items: center;
		width: var(--pl-tap);
		height: var(--pl-tap);
		flex: none;
		border: 1px solid transparent;
		border-radius: var(--pl-radius);
		background: transparent;
		color: var(--pl-dim);
	}

	.branch-action:hover:not(:disabled) {
		background: var(--pl-hover);
		color: var(--pl-ink);
	}

	.branch-action.danger:hover:not(:disabled) {
		color: var(--pl-danger);
	}

	.branch-action:disabled {
		opacity: 0.4;
	}

	.branch-add {
		min-height: var(--pl-tap);
		padding: 0 12px;
		flex: none;
		border: 1px dashed var(--pl-line-strong);
		border-radius: var(--pl-radius);
		background: transparent;
		color: var(--pl-dim);
		font-size: 12px;
	}

	.branch-add:hover:not(:disabled) {
		background: var(--pl-hover);
		color: var(--pl-ink);
	}

	.branch-add:disabled {
		opacity: 0.45;
	}

	.inline-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.inline-row > label {
		display: contents;
	}

	.text-field {
		min-height: var(--pl-tap);
		flex: 1 1 140px;
		min-width: 0;
		padding: 0 10px;
		border: 1px solid var(--pl-line-strong);
		border-radius: var(--pl-radius);
		background: var(--pl-bg);
		color: var(--pl-ink);
		font-size: 13px;
	}

	.confirm-text {
		flex: 1 1 150px;
		font-size: 12px;
		color: var(--pl-dim);
	}

	.confirm-text strong {
		color: var(--pl-ink);
		font-weight: 600;
	}

	.timeline-main {
		display: grid;
		gap: 10px;
		align-items: start;
	}

	.preview-wrap {
		position: relative;
		aspect-ratio: 16 / 10;
		min-width: 0;
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius);
		overflow: hidden;
		background: var(--pl-bg);
	}

	.preview-canvas {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.preview-note {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 12px;
		text-align: center;
		font-size: 12px;
		color: var(--pl-dim);
		background: color-mix(in srgb, var(--pl-panel) 82%, transparent);
	}

	.preview-note.empty {
		color: var(--pl-faint);
	}

	.replay-controls {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.readout {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 11px;
		color: var(--pl-dim);
		min-width: 0;
	}

	.readout-index {
		font-size: 12px;
		font-weight: 600;
		color: var(--pl-ink);
	}

	.cursor-readout {
		margin-left: auto;
		font-size: 10px;
		color: var(--pl-faint);
		white-space: nowrap;
	}

	.scrub-wrap {
		position: relative;
		display: flex;
		align-items: center;
		height: var(--pl-tap);
	}

	.scrub {
		appearance: none;
		-webkit-appearance: none;
		width: 100%;
		height: var(--pl-tap);
		margin: 0;
		background: transparent;
		touch-action: none;
	}

	.scrub::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: var(--pl-line-strong);
	}

	.scrub::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 16px;
		height: 16px;
		margin-top: -6px;
		border-radius: 50%;
		background: var(--pl-ink);
		border: 0;
	}

	.scrub::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: var(--pl-line-strong);
	}

	.scrub::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--pl-ink);
		border: 0;
	}

	.scrub:disabled {
		opacity: 0.4;
	}

	.cursor-marker {
		position: absolute;
		top: 50%;
		width: 2px;
		height: 16px;
		transform: translate(-1px, -50%);
		border-radius: 1px;
		background: color-mix(in srgb, var(--pl-ink) 55%, transparent);
		pointer-events: none;
	}

	.replay-buttons {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: var(--pl-tap);
		padding: 0 12px;
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius);
		background: var(--pl-raised);
		color: var(--pl-ink);
		font-size: 12px;
	}

	.action:hover:not(:disabled) {
		background: var(--pl-hover);
	}

	.action:disabled {
		opacity: 0.45;
	}

	.action.primary {
		background: var(--pl-accent);
		border-color: var(--pl-accent);
		color: #0d0d0f;
		font-weight: 600;
	}

	.action.primary:hover:not(:disabled) {
		background: #93b4ff;
	}

	.action.danger {
		background: transparent;
		border-color: color-mix(in srgb, var(--pl-danger) 50%, var(--pl-line));
		color: var(--pl-danger);
	}

	.action.play {
		width: var(--pl-tap);
		flex: none;
		padding: 0;
	}

	.action.grow {
		flex: 1 1 104px;
	}

	.select {
		min-height: var(--pl-tap);
		padding: 0 8px;
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius);
		background: var(--pl-raised);
		color: var(--pl-ink);
		font-size: 12px;
	}

	.select:disabled {
		opacity: 0.45;
	}

	.select option {
		background: var(--pl-panel);
		color: var(--pl-ink);
	}

	.thumbs {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		touch-action: pan-x;
		padding: 1px 0;
		scrollbar-width: none;
		flex: none;
	}

	.thumbs::-webkit-scrollbar {
		display: none;
	}

	.thumb {
		width: var(--pl-tap);
		height: var(--pl-tap);
		flex: none;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--pl-line);
		border-radius: 8px;
		background: var(--pl-bg);
	}

	.thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0.82;
	}

	.thumb.current {
		border-color: var(--pl-accent);
		box-shadow: 0 0 0 1px var(--pl-accent);
	}
	.thumb.current img {
		opacity: 1;
	}

	.thumb:disabled {
		opacity: 0.5;
	}

	.export-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		padding-top: 8px;
		border-top: 1px solid var(--pl-line);
		flex: none;
	}

	.export-fields {
		display: flex;
		gap: 6px;
	}

	.export-row .export {
		margin-left: auto;
		flex: 1 1 120px;
	}

	.progress {
		height: 4px;
		border-radius: 2px;
		overflow: hidden;
		background: var(--pl-line);
		flex: none;
	}

	.progress > span {
		display: block;
		height: 100%;
		background: var(--pl-accent);
		transition: width 120ms linear;
	}

	.error {
		margin: 0;
		font-size: 11px;
		color: var(--pl-danger);
		overflow-wrap: anywhere;
	}

	@media (min-width: 640px) {
		.timeline-main {
			grid-template-columns: 320px minmax(0, 1fr);
		}
	}

	@media (max-width: 900px) {
		.timeline-layer {
			left: 0;
			right: 0;
			bottom: calc(var(--pl-bar) + 60px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.timeline-sheet,
		.timeline-layer {
			transition: none;
		}

		.progress > span {
			transition: none;
		}
	}
</style>
