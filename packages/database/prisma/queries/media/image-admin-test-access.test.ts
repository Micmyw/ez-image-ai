import { describe, expect, it, vi } from "vitest";

import { loadImageAdminTestSkuKeys } from "./image-admin-test-access";

const now = new Date("2026-11-13T15:00:00Z");
const value = {
	version: 1,
	expiresAt: "2026-11-14T15:00:00Z",
	skuKeys: ["gpt-image-2-6-sunburst-1k"],
};

describe("account-scoped administrator image testing", () => {
	it("reads only the named owner's active grant and current administrator identity", async () => {
		const tx = { $queryRaw: vi.fn(async () => [{ value, now }]) };
		await expect(loadImageAdminTestSkuKeys("owner", tx as never)).resolves.toEqual(value.skuKeys);
		const [parts, ...parameters] = tx.$queryRaw.mock.calls[0] as unknown as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(parts.join("?")).toContain("account.\"role\" = 'admin'");
		expect(parts.join("?")).toContain('account."banned" IS NOT TRUE');
		expect(parts.join("?")).toContain("clock_timestamp()");
		expect(parameters).toEqual(["owner", "media.image-admin-test.owner"]);
	});
	it.each([
		null,
		{ ...value, version: 2 },
		{ ...value, expiresAt: now.toISOString() },
		{ ...value, expiresAt: "invalid" },
		{ ...value, skuKeys: ["video-anything"] },
	])("does not apply an absent, expired or invalid grant: %j", async (value) => {
		const tx = { $queryRaw: vi.fn(async () => [{ value, now }]) };
		await expect(loadImageAdminTestSkuKeys("owner", tx as never)).resolves.toEqual([]);
	});
	it("does not grant access without a matching administrator and configuration row", async () => {
		await expect(
			loadImageAdminTestSkuKeys("other", { $queryRaw: async () => [] } as never),
		).resolves.toEqual([]);
	});
});
