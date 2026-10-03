import { describe, expect, it } from "vitest";

import { contentPagePath, paginateContent, parseContentPage } from "./pagination";

describe("public content pagination", () => {
	it("keeps later pages independently reachable without empty pages", () => {
		const items = Array.from({ length: 25 }, (_, index) => index);
		expect(paginateContent(items)?.items).toHaveLength(12);
		expect(paginateContent(items, "2")?.items).toEqual(items.slice(12, 24));
		expect(paginateContent(items, "3")?.items).toEqual([24]);
		expect(paginateContent(items, "4")).toBeNull();
		expect(contentPagePath("/effects", 1)).toBe("/effects");
		expect(contentPagePath("/effects", 2)).toBe("/effects?page=2");
	});
	it("rejects malformed, repeated and unsafe page parameters", () => {
		for (const raw of ["0", "-1", "01", "1.5", "1e3", "9007199254740992", ["1", "2"]]) {
			expect(parseContentPage(raw)).toBeNull();
		}
		expect(paginateContent([])?.page).toBe(1);
		expect(paginateContent([], "2")).toBeNull();
	});
});
