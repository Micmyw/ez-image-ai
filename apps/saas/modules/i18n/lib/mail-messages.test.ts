import { describe, expect, it } from "vitest";

import { getTemplate } from "../../../../../packages/mail/lib/templates";

describe("localized transactional email after scoped loading", () => {
	it.each(["en", "de", "es", "fr"] as const)("renders the sign-in link in %s", async (locale) => {
		const url = "https://example.invalid/auth/magic-link?token=fixture&callbackURL=%2Fcreate";
		const message = await getTemplate({
			templateId: "magicLink",
			locale,
			context: { url },
		});
		expect(message.subject).not.toBe("");
		expect(message.html).toContain('href="https://example.invalid/auth/magic-link?');
		expect(message.html).toContain("callbackURL=%2Fcreate");
		expect(message.text).toContain(url);
		expect(message.text).not.toMatch(/MISSING_MESSAGE|undefined/);
	});
});
