import { describe, expect, it } from "vitest";

import sitemap from "./sitemap";

describe("marketing sitemap", () => {
	it("publishes only default-English URLs while retaining the approved public pages", async () => {
		const entries = await sitemap();
		const paths = entries.map(({ url }) => new URL(url).pathname);

		expect(paths.sort()).toEqual(["/", "/pricing", "/privacy", "/terms"]);
		expect(paths).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/^\/(?:de|es|fr)(?:\/|$)/)]),
		);
	});
});
