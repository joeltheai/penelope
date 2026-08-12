import type { RasterPatch, Rect } from '$lib/gpuPaint';

const DB_NAME = 'penelope-history';
const DB_VERSION = 2;
const PROJECT_ID = 'default';
const MAIN_BRANCH_ID = 'main';

type StoredProject = {
	id: typeof PROJECT_ID;
	version: 1;
	width: number;
	height: number;
	activeBranchId: string;
	cursorNodeId: string | null;
	nextBranchNumber: number;
};

type StoredBaseline = {
	id: typeof PROJECT_ID;
	pixels: ArrayBuffer;
};

type StoredPatch = {
	nodeId: string;
	before: ArrayBuffer;
	after: ArrayBuffer;
};

export type HistoryNode = {
	id: string;
	parentId: string | null;
	branchId: string;
	createdAt: number;
	bounds: Rect;
};

export type HistoryBranch = {
	id: string;
	name: string;
	tipNodeId: string | null;
	createdAt: number;
	updatedAt: number;
};

export type HistoryGraphBranch = HistoryBranch & {
	forkNodeId: string | null;
	parentBranchId: string | null;
	length: number;
	active: boolean;
};

export type HistoryGraphData = {
	revision: string;
	width: number;
	height: number;
	activeBranchId: string;
	cursorNodeId: string | null;
	nodes: HistoryNode[];
	branches: HistoryGraphBranch[];
};

export type HistorySnapshot = {
	nodeId: string | null;
	blob: Blob;
	width: number;
	height: number;
};

export type HistoryUiState = {
	ready: boolean;
	busy: boolean;
	replaying: boolean;
	exportProgress: number | null;
	error: string | null;
	activeBranchId: string;
	cursorNodeId: string | null;
	currentIndex: number;
	total: number;
	canUndo: boolean;
	canRedo: boolean;
	branches: Array<HistoryBranch & { length: number; active: boolean }>;
};

export type HistoryApi = {
	undo: () => Promise<void>;
	redo: () => Promise<void>;
	seek: (index: number) => Promise<void>;
	fork: () => Promise<void>;
	switchBranch: (branchId: string) => Promise<void>;
	renameBranch: (branchId: string, name: string) => Promise<void>;
	deleteBranch: (branchId: string) => Promise<void>;
	getGraph: () => Promise<HistoryGraphData>;
	getSnapshots: (nodeIds: Array<string | null>) => Promise<HistorySnapshot[]>;
	openReplay: (
		branchId: string,
		canvas: HTMLCanvasElement
	) => Promise<{ index: number; total: number }>;
	seekReplay: (index: number) => Promise<number>;
	playReplay: (options: {
		fps: number;
		onFrame?: (index: number) => void;
	}) => Promise<void>;
	pauseReplay: () => void;
	closeReplay: () => void;
	exportVideo: (options: {
		fps: number;
		maxDimension: 720 | 1280 | 1920;
		branchId?: string;
	}) => Promise<void>;
};

export const EMPTY_HISTORY_STATE: HistoryUiState = {
	ready: false,
	busy: false,
	replaying: false,
	exportProgress: null,
	error: null,
	activeBranchId: MAIN_BRANCH_ID,
	cursorNodeId: null,
	currentIndex: 0,
	total: 0,
	canUndo: false,
	canRedo: false,
	branches: []
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
		tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
	});
}

async function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains('project')) db.createObjectStore('project', { keyPath: 'id' });
			if (!db.objectStoreNames.contains('nodes')) db.createObjectStore('nodes', { keyPath: 'id' });
			if (!db.objectStoreNames.contains('patches')) db.createObjectStore('patches', { keyPath: 'nodeId' });
			if (!db.objectStoreNames.contains('branches')) db.createObjectStore('branches', { keyPath: 'id' });
			if (!db.objectStoreNames.contains('baseline')) {
				const baselineStore = db.createObjectStore('baseline', { keyPath: 'id' });
				if (request.transaction && db.objectStoreNames.contains('project')) {
					const projectStore = request.transaction.objectStore('project');
					const legacyRequest = projectStore.get(PROJECT_ID);
					legacyRequest.onsuccess = () => {
						const legacy = legacyRequest.result as
							| (StoredProject & { baseline?: ArrayBuffer })
							| undefined;
						if (!legacy?.baseline) return;
						baselineStore.put({ id: PROJECT_ID, pixels: legacy.baseline } satisfies StoredBaseline);
						delete legacy.baseline;
						projectStore.put(legacy);
					};
				}
			}
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onblocked = () => reject(new Error('History database upgrade is blocked by another tab'));
		request.onerror = () => reject(request.error ?? new Error('Could not open history database'));
	});
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

export function applyRasterPatch(target: Uint8Array, docWidth: number, bounds: Rect, patch: Uint8Array) {
	const rowBytes = bounds.w * 4;
	for (let row = 0; row < bounds.h; row++) {
		const sourceOffset = row * rowBytes;
		const targetOffset = ((bounds.y + row) * docWidth + bounds.x) * 4;
		target.set(patch.subarray(sourceOffset, sourceOffset + rowBytes), targetOffset);
	}
}

function makeWhiteDocument(width: number, height: number) {
	return new Uint8Array(width * height * 4).fill(255);
}

export class PersistentHistory {
	private constructor(
		private readonly db: IDBDatabase,
		private project: StoredProject,
		private baseline: ArrayBuffer,
		private readonly nodes: Map<string, HistoryNode>,
		private readonly branches: Map<string, HistoryBranch>
	) {}

	static async open(width: number, height: number): Promise<PersistentHistory> {
		const db = await openDatabase();
		const tx = db.transaction(['project', 'baseline', 'nodes', 'branches'], 'readonly');
		const [storedProject, storedBaseline, storedNodes, storedBranches] = await Promise.all([
			requestResult(tx.objectStore('project').get(PROJECT_ID) as IDBRequest<StoredProject | undefined>),
			requestResult(
				tx.objectStore('baseline').get(PROJECT_ID) as IDBRequest<StoredBaseline | undefined>
			),
			requestResult(tx.objectStore('nodes').getAll() as IDBRequest<HistoryNode[]>),
			requestResult(tx.objectStore('branches').getAll() as IDBRequest<HistoryBranch[]>)
		]);
		await transactionDone(tx);

		if (storedProject && storedBaseline) {
			return new PersistentHistory(
				db,
				storedProject,
				storedBaseline.pixels,
				new Map(storedNodes.map((node) => [node.id, node])),
				new Map(storedBranches.map((branch) => [branch.id, branch]))
			);
		}

		const now = Date.now();
		const main: HistoryBranch = {
			id: MAIN_BRANCH_ID,
			name: 'Main',
			tipNodeId: null,
			createdAt: now,
			updatedAt: now
		};
		const project: StoredProject = {
			id: PROJECT_ID,
			version: 1,
			width,
			height,
			activeBranchId: main.id,
			cursorNodeId: null,
			nextBranchNumber: 1
		};
		const baseline = makeWhiteDocument(width, height).buffer;
		const createTx = db.transaction(['project', 'baseline', 'branches'], 'readwrite');
		createTx.objectStore('project').put(project);
		createTx.objectStore('baseline').put({ id: PROJECT_ID, pixels: baseline } satisfies StoredBaseline);
		createTx.objectStore('branches').put(main);
		await transactionDone(createTx);
		return new PersistentHistory(db, project, baseline, new Map(), new Map([[main.id, main]]));
	}

	get width() {
		return this.project.width;
	}

	get height() {
		return this.project.height;
	}

	get activeBranchId() {
		return this.project.activeBranchId;
	}

	get cursorNodeId() {
		return this.project.cursorNodeId;
	}

	getPath(branchId = this.project.activeBranchId): HistoryNode[] {
		const branch = this.branches.get(branchId);
		if (!branch) return [];
		const reverse: HistoryNode[] = [];
		let id = branch.tipNodeId;
		while (id) {
			const node = this.nodes.get(id);
			if (!node) break;
			reverse.push(node);
			id = node.parentId;
		}
		return reverse.reverse();
	}

	getState(): HistoryUiState {
		const activePath = this.getPath();
		const cursorIndex = this.project.cursorNodeId
			? activePath.findIndex((node) => node.id === this.project.cursorNodeId) + 1
			: 0;
		const currentIndex = Math.max(0, cursorIndex);
		const branches = [...this.branches.values()]
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((branch) => ({
				...branch,
				length: this.getPath(branch.id).length,
				active: branch.id === this.project.activeBranchId
			}));
		return {
			...EMPTY_HISTORY_STATE,
			ready: true,
			activeBranchId: this.project.activeBranchId,
			cursorNodeId: this.project.cursorNodeId,
			currentIndex,
			total: activePath.length,
			canUndo: this.project.cursorNodeId !== null,
			canRedo: currentIndex < activePath.length,
			branches
		};
	}

	getGraphData(): HistoryGraphData {
		const nodes = [...this.nodes.values()].sort(
			(a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
		);
		const branches = [...this.branches.values()]
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
			.map((branch): HistoryGraphBranch => {
				const path = this.getPath(branch.id);
				const firstOwnNode = path.find((node) => node.branchId === branch.id);
				const forkNodeId = firstOwnNode ? firstOwnNode.parentId : branch.tipNodeId;
				const ownerBranchId = forkNodeId ? this.nodes.get(forkNodeId)?.branchId : undefined;
				const parentBranchId =
					ownerBranchId && ownerBranchId !== branch.id && this.branches.has(ownerBranchId)
						? ownerBranchId
						: null;
				return {
					...branch,
					forkNodeId,
					parentBranchId,
					length: path.length,
					active: branch.id === this.project.activeBranchId
				};
			});
		const branchRevision = branches
			.map((branch) => `${branch.id}:${branch.tipNodeId ?? 'root'}:${branch.updatedAt}`)
			.join('|');
		return {
			revision: `${this.project.width}x${this.project.height}:${nodes.length}:${branchRevision}`,
			width: this.project.width,
			height: this.project.height,
			activeBranchId: this.project.activeBranchId,
			cursorNodeId: this.project.cursorNodeId,
			nodes,
			branches
		};
	}

	private async getStoredPatch(nodeId: string): Promise<StoredPatch> {
		const tx = this.db.transaction('patches', 'readonly');
		const patch = await requestResult(
			tx.objectStore('patches').get(nodeId) as IDBRequest<StoredPatch | undefined>
		);
		await transactionDone(tx);
		if (!patch) throw new Error(`Missing history patch ${nodeId}`);
		return patch;
	}

	private async saveProject(project: StoredProject) {
		const tx = this.db.transaction('project', 'readwrite');
		tx.objectStore('project').put(project);
		await transactionDone(tx);
	}

	async materialize(nodeId = this.project.cursorNodeId): Promise<Uint8Array> {
		const pixels = new Uint8Array(this.baseline.slice(0));
		if (!nodeId) return pixels;
		const reverse: HistoryNode[] = [];
		let id: string | null = nodeId;
		while (id) {
			const node = this.nodes.get(id);
			if (!node) throw new Error(`Missing history node ${id}`);
			reverse.push(node);
			id = node.parentId;
		}
		for (const node of reverse.reverse()) {
			const patch = await this.getStoredPatch(node.id);
			applyRasterPatch(pixels, this.project.width, node.bounds, new Uint8Array(patch.after));
		}
		return pixels;
	}

	private async transitionTo(
		targetNodeId: string | null,
		apply: (bounds: Rect, pixels: Uint8Array) => void | Promise<void>,
		activeBranchId = this.project.activeBranchId
	) {
		if (
			targetNodeId === this.project.cursorNodeId
			&& activeBranchId === this.project.activeBranchId
		) {
			return;
		}
		if (targetNodeId && !this.nodes.has(targetNodeId)) throw new Error('Unknown history state');

		const steps: Array<{ bounds: Rect; pixels: Uint8Array; rollback: Uint8Array }> = [];
		const targetAncestors = new Set<string>();
		let id = targetNodeId;
		while (id) {
			targetAncestors.add(id);
			id = this.nodes.get(id)?.parentId ?? null;
		}

		let current = this.project.cursorNodeId;
		while (current && !targetAncestors.has(current)) {
			const node = this.nodes.get(current);
			if (!node) throw new Error(`Missing history node ${current}`);
			const patch = await this.getStoredPatch(node.id);
			steps.push({
				bounds: node.bounds,
				pixels: new Uint8Array(patch.before),
				rollback: new Uint8Array(patch.after)
			});
			current = node.parentId;
		}
		const commonAncestor = current;

		const forward: HistoryNode[] = [];
		id = targetNodeId;
		while (id && id !== commonAncestor) {
			const node = this.nodes.get(id);
			if (!node) throw new Error(`Missing history node ${id}`);
			forward.push(node);
			id = node.parentId;
		}
		for (const node of forward.reverse()) {
			const patch = await this.getStoredPatch(node.id);
			steps.push({
				bounds: node.bounds,
				pixels: new Uint8Array(patch.after),
				rollback: new Uint8Array(patch.before)
			});
		}

		const applied: typeof steps = [];
		try {
			for (const step of steps) {
				await apply(step.bounds, step.pixels);
				applied.push(step);
			}
			const nextProject = {
				...this.project,
				cursorNodeId: targetNodeId,
				activeBranchId
			};
			await this.saveProject(nextProject);
			this.project = nextProject;
		} catch (error) {
			for (const step of applied.reverse()) {
				try {
					await apply(step.bounds, step.rollback);
				} catch {
					// Keep the original transition error.
				}
			}
			throw error;
		}
	}

	async seek(
		targetNodeId: string | null,
		apply: (bounds: Rect, pixels: Uint8Array) => void | Promise<void>
	) {
		await this.transitionTo(targetNodeId, apply);
	}

	async seekIndex(
		index: number,
		apply: (bounds: Rect, pixels: Uint8Array) => void | Promise<void>
	) {
		const path = this.getPath();
		const clamped = Math.max(0, Math.min(path.length, Math.round(index)));
		await this.seek(clamped === 0 ? null : path[clamped - 1]!.id, apply);
	}

	async undo(apply: (bounds: Rect, pixels: Uint8Array) => void | Promise<void>) {
		const node = this.project.cursorNodeId ? this.nodes.get(this.project.cursorNodeId) : null;
		if (!node) return false;
		await this.seek(node.parentId, apply);
		return true;
	}

	async redo(apply: (bounds: Rect, pixels: Uint8Array) => void | Promise<void>) {
		const path = this.getPath();
		const currentIndex = this.project.cursorNodeId
			? path.findIndex((node) => node.id === this.project.cursorNodeId) + 1
			: 0;
		const next = path[currentIndex];
		if (!next) return false;
		await this.seek(next.id, apply);
		return true;
	}

	async fork(name?: string): Promise<HistoryBranch> {
		const now = Date.now();
		const branchNumber = this.project.nextBranchNumber;
		const branch: HistoryBranch = {
			id: crypto.randomUUID(),
			name: name?.trim() || `Branch ${branchNumber}`,
			tipNodeId: this.project.cursorNodeId,
			createdAt: now,
			updatedAt: now
		};
		const nextProject = {
			...this.project,
			activeBranchId: branch.id,
			nextBranchNumber: branchNumber + 1
		};
		const tx = this.db.transaction(['project', 'branches'], 'readwrite');
		tx.objectStore('project').put(nextProject);
		tx.objectStore('branches').put(branch);
		await transactionDone(tx);
		this.project = nextProject;
		this.branches.set(branch.id, branch);
		return branch;
	}

	async append(patch: RasterPatch): Promise<{ node: HistoryNode; forked: boolean }> {
		let forked = false;
		const active = this.branches.get(this.project.activeBranchId);
		if (!active) throw new Error('Active history branch is missing');
		if (active.tipNodeId !== this.project.cursorNodeId) {
			await this.fork();
			forked = true;
		}
		const currentBranch = this.branches.get(this.project.activeBranchId)!;
		const branch = { ...currentBranch };
		const now = Date.now();
		const node: HistoryNode = {
			id: crypto.randomUUID(),
			parentId: this.project.cursorNodeId,
			branchId: branch.id,
			createdAt: now,
			bounds: { ...patch.bounds }
		};
		const storedPatch: StoredPatch = {
			nodeId: node.id,
			before: copyBuffer(patch.before),
			after: copyBuffer(patch.after)
		};
		branch.tipNodeId = node.id;
		branch.updatedAt = now;
		const nextProject = { ...this.project, cursorNodeId: node.id };

		const tx = this.db.transaction(['project', 'nodes', 'patches', 'branches'], 'readwrite');
		tx.objectStore('project').put(nextProject);
		tx.objectStore('nodes').put(node);
		tx.objectStore('patches').put(storedPatch);
		tx.objectStore('branches').put(branch);
		await transactionDone(tx);
		this.project = nextProject;
		this.nodes.set(node.id, node);
		this.branches.set(branch.id, branch);
		return { node, forked };
	}

	async switchBranch(
		branchId: string,
		apply: (bounds: Rect, pixels: Uint8Array) => void | Promise<void>
	) {
		const branch = this.branches.get(branchId);
		if (!branch) throw new Error('Unknown history branch');
		await this.transitionTo(branch.tipNodeId, apply, branchId);
	}

	async renameBranch(branchId: string, name: string) {
		const branch = this.branches.get(branchId);
		if (!branch) throw new Error('Unknown history branch');
		const trimmed = name.trim().slice(0, 64);
		if (!trimmed) throw new Error('Branch name cannot be empty');
		if (branch.name === trimmed) return;
		const nextBranch = { ...branch, name: trimmed, updatedAt: Date.now() };
		const tx = this.db.transaction('branches', 'readwrite');
		tx.objectStore('branches').put(nextBranch);
		await transactionDone(tx);
		this.branches.set(branchId, nextBranch);
	}

	async deleteBranch(
		branchId: string,
		apply: (bounds: Rect, pixels: Uint8Array) => void | Promise<void>
	) {
		const deletedBranch = this.branches.get(branchId);
		if (!deletedBranch) throw new Error('Unknown history branch');

		const deletedPath = this.getPath(branchId);
		const remainingBranches = [...this.branches.values()].filter(
			(branch) => branch.id !== branchId
		);
		let replacement: HistoryBranch | null = null;
		if (remainingBranches.length === 0) {
			const now = Date.now();
			replacement = {
				id: crypto.randomUUID(),
				name: 'Main',
				tipNodeId: null,
				createdAt: now,
				updatedAt: now
			};
			await this.transitionTo(null, apply, branchId);
		} else if (this.project.activeBranchId === branchId) {
			const deletedIds = deletedPath.map((node) => node.id);
			const sharedLength = (branch: HistoryBranch) => {
				const path = this.getPath(branch.id);
				let index = 0;
				while (index < deletedIds.length && path[index]?.id === deletedIds[index]) index++;
				return index;
			};
			const fallback = remainingBranches.reduce((best, branch) =>
				sharedLength(branch) > sharedLength(best) ? branch : best
			);
			await this.transitionTo(fallback.tipNodeId, apply, fallback.id);
		}

		const reachableNodeIds = new Set<string>();
		for (const branch of remainingBranches) {
			let nodeId = branch.tipNodeId;
			while (nodeId && !reachableNodeIds.has(nodeId)) {
				reachableNodeIds.add(nodeId);
				nodeId = this.nodes.get(nodeId)?.parentId ?? null;
			}
		}
		const deletedNodeIds = [...this.nodes.keys()].filter((id) => !reachableNodeIds.has(id));
		const nextProject = replacement
			? {
					...this.project,
					activeBranchId: replacement.id,
					cursorNodeId: null
				}
			: this.project;

		const tx = this.db.transaction(['project', 'nodes', 'patches', 'branches'], 'readwrite');
		tx.objectStore('project').put(nextProject);
		tx.objectStore('branches').delete(branchId);
		if (replacement) tx.objectStore('branches').put(replacement);
		for (const id of deletedNodeIds) {
			tx.objectStore('nodes').delete(id);
			tx.objectStore('patches').delete(id);
		}
		await transactionDone(tx);
		this.project = nextProject;
		for (const id of deletedNodeIds) this.nodes.delete(id);
		this.branches.delete(branchId);
		if (replacement) this.branches.set(replacement.id, replacement);
	}

	async reset(width: number, height: number, baseline: Uint8Array) {
		const now = Date.now();
		const main: HistoryBranch = {
			id: MAIN_BRANCH_ID,
			name: 'Main',
			tipNodeId: null,
			createdAt: now,
			updatedAt: now
		};
		const nextProject: StoredProject = {
			id: PROJECT_ID,
			version: 1,
			width,
			height,
			activeBranchId: main.id,
			cursorNodeId: null,
			nextBranchNumber: 1
		};
		const nextBaseline = copyBuffer(baseline);

		const tx = this.db.transaction(
			['project', 'baseline', 'nodes', 'patches', 'branches'],
			'readwrite'
		);
		tx.objectStore('nodes').clear();
		tx.objectStore('patches').clear();
		tx.objectStore('branches').clear();
		tx.objectStore('project').put(nextProject);
		tx.objectStore('baseline').put({
			id: PROJECT_ID,
			pixels: nextBaseline
		} satisfies StoredBaseline);
		tx.objectStore('branches').put(main);
		await transactionDone(tx);
		this.project = nextProject;
		this.baseline = nextBaseline;
		this.nodes.clear();
		this.branches.clear();
		this.branches.set(main.id, main);
	}

	async getExportData(branchId = this.project.activeBranchId) {
		return {
			width: this.project.width,
			height: this.project.height,
			baseline: new Uint8Array(this.baseline.slice(0)),
			frames: this.getPath(branchId)
		};
	}

	async getAfterPatch(nodeId: string) {
		const patch = await this.getStoredPatch(nodeId);
		return new Uint8Array(patch.after);
	}

	getBaselinePixels() {
		return new Uint8Array(this.baseline.slice(0));
	}

	async getRasterPatch(nodeId: string) {
		const patch = await this.getStoredPatch(nodeId);
		return {
			before: new Uint8Array(patch.before),
			after: new Uint8Array(patch.after)
		};
	}

	close() {
		this.db.close();
	}
}
