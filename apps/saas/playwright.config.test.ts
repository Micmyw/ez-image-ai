import { describe, expect, it } from "vitest";

import config from "./playwright.config";

describe("SaaS Playwright project selection", () => {
	it("collects guest-only specs only in the guest project", () => {
		const projects = config.projects ?? [];
		const guest = projects.find((project) => project.name === "guest");
		const registered = projects.filter((project) =>
			["funded", "empty", "free"].includes(project.name ?? ""),
		);

		expect(guest?.testMatch?.toString()).toContain("guest-trial");
		for (const project of registered) {
			expect(project.testIgnore).toBeDefined();
			expect(project.testIgnore?.toString()).toContain("guest-trial");
		}
	});
});
