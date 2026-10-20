import { replaceEqualDeep } from "@tanstack/react-query";

export interface LoadedHistory<T> {
	pages: Array<{ items: T[] }>;
	pageParams: unknown[];
}

/** Read every loaded active item, including older pages, without rereading settled pages. */
export async function readActiveHistory<TItem, TUpdate>({
	data,
	getId,
	isActive,
	read,
	signal,
}: {
	data: LoadedHistory<TItem>;
	getId: (item: TItem) => string;
	isActive: (item: TItem) => boolean;
	read: (id: string) => Promise<TUpdate>;
	signal: AbortSignal;
}): Promise<Map<string, TUpdate>> {
	const ids = [...new Set(data.pages.flatMap((page) => page.items.filter(isActive).map(getId)))];
	const updates = new Map<string, TUpdate>();
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, ids.length) }, async () => {
			while (!signal.aborted) {
				const id = ids[next++];
				if (!id) return;
				try {
					const update = await read(id);
					if (!signal.aborted) updates.set(id, update);
				} catch {
					// Keep the last known state. A later read or explicit list refresh can recover.
				}
			}
		}),
	);
	return updates;
}

/** Keep page order/cursors intact; a status filter may remove a newly terminal item. */
export function mergeActiveHistory<TItem, TUpdate>(
	data: LoadedHistory<TItem>,
	updates: ReadonlyMap<string, TUpdate>,
	getId: (item: TItem) => string,
	merge: (item: TItem, update: TUpdate) => TItem | null,
): LoadedHistory<TItem> {
	let changed = false;
	const pages = data.pages.map((page) => {
		let pageChanged = false;
		const items = page.items.flatMap((item) => {
			const update = updates.get(getId(item));
			if (update === undefined) return [item];
			const next = replaceEqualDeep(item, merge(item, update));
			if (next !== item) pageChanged = true;
			return next === null ? [] : [next];
		});
		if (!pageChanged) return page;
		changed = true;
		return { ...page, items };
	});
	return changed ? { ...data, pages } : data;
}
