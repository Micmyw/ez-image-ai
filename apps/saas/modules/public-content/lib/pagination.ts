export const CONTENT_PAGE_SIZE = 12;

export function parseContentPage(raw: string | string[] | undefined): number | null {
	if (raw === undefined) return 1;
	if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
	const page = Number(raw);
	return Number.isSafeInteger(page) ? page : null;
}

export function contentPagePath(base: string, page: number): string {
	return page === 1 ? base : `${base}?page=${page}`;
}

export function paginateContent<T>(items: readonly T[], raw?: string | string[]) {
	const page = parseContentPage(raw);
	const totalPages = Math.max(1, Math.ceil(items.length / CONTENT_PAGE_SIZE));
	if (page === null || page > totalPages) return null;
	return {
		items: items.slice((page - 1) * CONTENT_PAGE_SIZE, page * CONTENT_PAGE_SIZE),
		page,
		totalPages,
		totalItems: items.length,
	};
}
