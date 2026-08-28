import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({ brand: "EzPic image editor", signIn: "Sign in", createAccount: "Create account" })[
			key as "brand" | "signIn" | "createAccount"
		],
}));

import { GuestShell } from "./GuestShell";

describe("GuestShell", () => {
	it("keeps the EzPic wordmark visible at the mobile trust boundary", () => {
		const markup = renderToStaticMarkup(
			<GuestShell>
				<div>Guest editor</div>
			</GuestShell>,
		);
		const labelClasses = markup.match(/<span class="([^"]*)">EzPic<\/span>/)?.[1].split(" ");

		expect(labelClasses).toBeDefined();
		expect(labelClasses).not.toContain("hidden");
		expect(markup).toMatch(/<svg(?=[^>]*aria-hidden="true")[^>]*>/);
		expect(markup.match(/<title>/g) ?? []).toHaveLength(0);
		expect(markup).toContain("Guest editor");
	});
});
