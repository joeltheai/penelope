import type { HistoryGraphData, HistoryNode } from '$lib/historyStore';

export type HistoryGraphCard = {
	id: string;
	nodeId: string | null;
	branchId: string | null;
	kind: 'root' | 'divergence' | 'tip' | 'current';
	title: string;
	subtitle: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type HistoryGraphEdge = {
	id: string;
	fromCardId: string;
	toCardId: string;
	path: string;
	label: string;
	labelX: number;
	labelY: number;
};

export type HistoryGraphLayout = {
	width: number;
	height: number;
	cards: HistoryGraphCard[];
	edges: HistoryGraphEdge[];
	snapshotNodeIds: Array<string | null>;
};

const CARD_WIDTH = 92;
const CARD_HEIGHT = 64;
const COLUMN_GAP = 44;
const ROW_GAP = 88;
const LEFT = 30;
const TOP = 30;

function keyForNode(nodeId: string | null) {
	return nodeId ?? '__root__';
}

export function layoutHistoryGraph(graph: HistoryGraphData): HistoryGraphLayout {
	const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
	const children = new Map<string | null, HistoryNode[]>();
	for (const node of graph.nodes) {
		const list = children.get(node.parentId) ?? [];
		list.push(node);
		children.set(node.parentId, list);
	}

	const depthByNode = new Map<string, number>();
	const depthOf = (nodeId: string | null): number => {
		if (!nodeId) return 0;
		const cached = depthByNode.get(nodeId);
		if (cached !== undefined) return cached;
		const depth = depthOf(nodesById.get(nodeId)?.parentId ?? null) + 1;
		depthByNode.set(nodeId, depth);
		return depth;
	};
	for (const node of graph.nodes) depthOf(node.id);

	const rowByBranch = new Map<string, number>();
	const usedRows = new Set<number>();
	const childCount = new Map<string, number>();
	const main = graph.branches.find((branch) => branch.parentBranchId === null) ?? graph.branches[0];
	if (main) {
		rowByBranch.set(main.id, 0);
		usedRows.add(0);
	}
	for (const branch of graph.branches) {
		if (rowByBranch.has(branch.id)) continue;
		const parentId = branch.parentBranchId ?? main?.id;
		const parentRow = parentId ? (rowByBranch.get(parentId) ?? 0) : 0;
		const index = childCount.get(parentId ?? '') ?? 0;
		childCount.set(parentId ?? '', index + 1);
		const direction = index % 2 === 0 ? -1 : 1;
		let distance = Math.floor(index / 2) + 1;
		let row = parentRow + direction * distance;
		while (usedRows.has(row)) {
			distance++;
			row = parentRow + direction * distance;
		}
		rowByBranch.set(branch.id, row);
		usedRows.add(row);
	}
	const minRow = Math.min(0, ...rowByBranch.values());
	const yForBranch = (branchId: string) =>
		TOP + ((rowByBranch.get(branchId) ?? 0) - minRow) * ROW_GAP;

	const significantDepths = new Set([0]);
	for (const branch of graph.branches) {
		significantDepths.add(depthOf(branch.tipNodeId));
		significantDepths.add(depthOf(branch.forkNodeId));
	}
	if (graph.cursorNodeId) significantDepths.add(depthOf(graph.cursorNodeId));
	const sortedDepths = [...significantDepths].sort((a, b) => a - b);
	const columnByDepth = new Map(sortedDepths.map((depth, index) => [depth, index]));
	const xForDepth = (depth: number) =>
		LEFT + (columnByDepth.get(depth) ?? sortedDepths.length) * (CARD_WIDTH + COLUMN_GAP);

	const cards: HistoryGraphCard[] = [
		{
			id: 'root',
			nodeId: null,
			branchId: graph.branches[0]?.id ?? null,
			kind: 'root',
			title: 'Beginning',
			subtitle: 'Start',
			x: LEFT,
			y: TOP,
			width: CARD_WIDTH,
			height: CARD_HEIGHT
		}
	];
	const stateCardByNode = new Map<string, string>();
	const divergenceIds = new Set<string>();
	for (const [parentId, childNodes] of children) {
		if (parentId && childNodes.length > 1) divergenceIds.add(parentId);
	}
	for (const branch of graph.branches) {
		if (branch.forkNodeId) divergenceIds.add(branch.forkNodeId);
	}

	for (const nodeId of divergenceIds) {
		const node = nodesById.get(nodeId);
		if (!node) continue;
		const id = `divergence:${node.id}`;
		stateCardByNode.set(node.id, id);
		cards.push({
			id,
			nodeId: node.id,
			branchId: null,
			kind: 'divergence',
			title: 'Divergence',
			subtitle: `${depthOf(node.id)} changes`,
			x: xForDepth(depthOf(node.id)),
			y: yForBranch(node.branchId),
			width: CARD_WIDTH,
			height: CARD_HEIGHT
		});
	}

	for (const branch of graph.branches) {
		const tipDepth = depthOf(branch.tipNodeId);
		let x = xForDepth(tipDepth);
		if (
			branch.tipNodeId === branch.forkNodeId ||
			(branch.tipNodeId && divergenceIds.has(branch.tipNodeId))
		) {
			x = xForDepth(tipDepth) + CARD_WIDTH + 28;
		}
		cards.push({
			id: `tip:${branch.id}`,
			nodeId: branch.tipNodeId,
			branchId: branch.id,
			kind: 'tip',
			title: branch.name,
			subtitle: `${branch.length} change${branch.length === 1 ? '' : 's'}${branch.active ? ' · active' : ''}`,
			x,
			y: yForBranch(branch.id),
			width: CARD_WIDTH,
			height: CARD_HEIGHT
		});
	}

	const cursorIsTip = graph.branches.some((branch) => branch.tipNodeId === graph.cursorNodeId);
	if (graph.cursorNodeId && !cursorIsTip && !stateCardByNode.has(graph.cursorNodeId)) {
		const node = nodesById.get(graph.cursorNodeId);
		if (node) {
			cards.push({
				id: 'current',
				nodeId: node.id,
				branchId: graph.activeBranchId,
				kind: 'current',
				title: 'Current position',
				subtitle: `${depthOf(node.id)} changes`,
				x: xForDepth(depthOf(node.id)),
				y: yForBranch(graph.activeBranchId),
				width: CARD_WIDTH,
				height: CARD_HEIGHT
			});
		}
	}

	const rows = new Map<number, HistoryGraphCard[]>();
	for (const card of cards) {
		const row = rows.get(card.y) ?? [];
		row.push(card);
		rows.set(card.y, row);
	}
	for (const row of rows.values()) {
		const kindOrder = { root: 0, divergence: 1, current: 2, tip: 3 };
		row.sort((a, b) => a.x - b.x || kindOrder[a.kind] - kindOrder[b.kind]);
		let right = -Infinity;
		for (const card of row) {
			card.x = Math.max(card.x, right + COLUMN_GAP);
			right = card.x + card.width;
		}
	}

	const cardById = new Map(cards.map((card) => [card.id, card]));
	const milestoneCardForAncestor = (nodeId: string | null, excludeId: string) => {
		let id = nodeId;
		while (id) {
			const stateCardId = stateCardByNode.get(id);
			if (stateCardId && stateCardId !== excludeId) return stateCardId;
			id = nodesById.get(id)?.parentId ?? null;
		}
		return 'root';
	};

	const edges: HistoryGraphEdge[] = [];
	for (const card of cards) {
		if (card.id === 'root') continue;
		const parentState = card.nodeId ? nodesById.get(card.nodeId)?.parentId ?? null : null;
		const sameStateCardId = card.nodeId ? stateCardByNode.get(card.nodeId) : undefined;
		const fromCardId =
			card.kind === 'tip' && sameStateCardId
				? sameStateCardId
				: card.kind === 'tip' && parentState && stateCardByNode.has(parentState)
					? stateCardByNode.get(parentState)!
					: milestoneCardForAncestor(parentState, card.id);
		const from = cardById.get(fromCardId);
		if (!from) continue;
		const fromDepth = depthOf(from.nodeId);
		const toDepth = depthOf(card.nodeId);
		const omitted = Math.max(0, toDepth - fromDepth);
		edges.push({
			id: `${from.id}->${card.id}`,
			fromCardId: from.id,
			toCardId: card.id,
			path: '',
			label: omitted > 1 ? `${omitted} changes` : '',
			labelX: 0,
			labelY: 0
		});
	}

	const width = Math.max(
		360,
		...cards.map((card) => card.x + card.width + LEFT)
	);
	const height = Math.max(
		220,
		...cards.map((card) => card.y + card.height + TOP)
	);
	const layout = {
		width,
		height,
		cards,
		edges,
		snapshotNodeIds: [...new Map(cards.map((card) => [keyForNode(card.nodeId), card.nodeId])).values()]
	};
	refreshHistoryGraphEdges(layout);
	return layout;
}

export function refreshHistoryGraphEdges(layout: HistoryGraphLayout) {
	const cards = new Map(layout.cards.map((card) => [card.id, card]));
	for (const edge of layout.edges) {
		const from = cards.get(edge.fromCardId);
		const to = cards.get(edge.toCardId);
		if (!from || !to) continue;
		const x1 = from.x + from.width;
		const y1 = from.y + from.height / 2;
		const x2 = to.x;
		const y2 = to.y + to.height / 2;
		const bend = Math.max(22, Math.abs(x2 - x1) * 0.42);
		edge.path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
		edge.labelX = (x1 + x2) / 2;
		edge.labelY = (y1 + y2) / 2 - 7;
	}
}
