import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({
	config: { appName: "EzPic", marketingUrl: "https://www.configured.test" },
}));
vi.mock("@repo/ui", () => ({
	cn: (...values: unknown[]) => values.filter((value) => typeof value === "string").join(" "),
	Logo: ({ label }: { label?: string }) => <span data-logo-label={label} />,
}));
vi.mock("./ColorModeToggle", () => ({ ColorModeToggle: () => null }));
vi.mock("./Footer", () => ({ Footer: () => null }));
vi.mock("./LocaleSwitch", () => ({
	LocaleSwitch: () => <span data-locale-switch="visible" />,
}));

import { AuthWrapper } from "./AuthWrapper";

describe("SaaS auth shell", () => {
	it("uses the configured EzPic label and hides unfinished locale switching", () => {
		const markup = renderToStaticMarkup(
			<AuthWrapper>
				<p>Sign in</p>
			</AuthWrapper>,
		);

		expect(markup).toContain('data-logo-label="EzPic"');
		expect(markup).not.toContain("data-locale-switch");
	});
});
