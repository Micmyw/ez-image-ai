import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({
	config: { appName: "EzPic" },
}));
vi.mock("@repo/ui", () => ({
	cn: (...values: unknown[]) => values.filter((value) => typeof value === "string").join(" "),
	Logo: ({ label }: { label?: string }) => <span data-logo-label={label} />,
}));
vi.mock("./ColorModeToggle", () => ({
	ColorModeToggle: () => <span data-color-mode-toggle="visible" />,
}));
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
		expect(markup).toContain('href="/"');
		expect(markup).toContain('data-color-mode-toggle="visible"');
		expect(markup).not.toContain("data-locale-switch");
	});

	it("keeps product context around unauthenticated forms", () => {
		const markup = renderToStaticMarkup(
			<AuthWrapper
				variant="product"
				productCopy={{
					eyebrow: "Image editor",
					title: "Edit a source image with a prompt",
					description: "Upload, describe, and review.",
					sequence: "Source · instruction · result",
					privateLabel: "Owner-scoped private media",
				}}
			>
				<p>Sign in</p>
			</AuthWrapper>,
		);

		expect(markup).toContain('data-auth-shell="product"');
		expect(markup).toContain("Edit a source image with a prompt");
		expect(markup).toContain("Owner-scoped private media");
		expect(markup).toContain("Sign in");
		expect(markup).not.toContain('data-color-mode-toggle="visible"');
	});
});
