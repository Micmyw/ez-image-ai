import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { describe, expect, it } from "vitest";

describe("unified application messages", () => {
	it("loads SaaS and landing-page namespaces for the same locale", async () => {
		const messages = await getUnifiedMessagesForLocale("en");

		expect(messages.auth).toBeDefined();
		expect(messages.home.generator.offer).toBe("Try one Standard edit free");
		expect(messages.common.menu.login).toBe("Sign In");
	});
});
