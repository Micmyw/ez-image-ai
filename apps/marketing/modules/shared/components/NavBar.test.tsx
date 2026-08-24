import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({
	config: { appName: "EzPic", saasUrl: "https://app.configured.test" },
}));
vi.mock("@i18n/routing", () => ({
	LocaleLink: ({
		children,
		href,
		className,
	}: {
		children: React.ReactNode;
		href: string;
		className?: string;
	}) => (
		<a className={className} href={href}>
			{children}
		</a>
	),
	useLocalePathname: () => "/",
}));
vi.mock("@repo/ui", () => ({
	cn: (...values: unknown[]) => values.filter((value) => typeof value === "string").join(" "),
	Logo: ({ label }: { label?: string }) => <span data-logo-label={label} />,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		className,
		render,
	}: {
		children?: React.ReactNode;
		className?: string;
		render?: (props: { className?: string }) => React.ReactNode;
	}) => (render ? render({ className }) : <button className={className}>{children}</button>),
}));
vi.mock("@repo/ui/components/sheet", () => ({
	Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SheetTitle: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
	SheetTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));
vi.mock("@shared/components/ColorModeToggle", () => ({ ColorModeToggle: () => null }));
vi.mock("@shared/components/LocaleSwitch", () => ({
	LocaleSwitch: () => <span data-locale-switch="visible" />,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			"common.menu.examples": "Examples",
			"common.menu.howItWorks": "How It Works",
			"common.menu.pricing": "Pricing",
			"common.menu.faq": "FAQ",
			"common.menu.blog": "Blog",
			"common.menu.changelog": "Changelog",
			"common.menu.contact": "Contact",
			"common.menu.docs": "Docs",
			"common.menu.login": "Sign In",
			"common.menu.startEditing": "Start Editing",
			"common.aria.menu": "Menu",
		})[key] ?? key,
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

import { NavBar } from "./NavBar";

describe("marketing navigation", () => {
	it("renders only the EzPic launch navigation and hides the locale switch", () => {
		const markup = renderToStaticMarkup(<NavBar />);

		for (const label of [
			"Examples",
			"How It Works",
			"Pricing",
			"FAQ",
			"Sign In",
			"Start Editing",
		]) {
			expect(markup).toContain(label);
		}
		for (const oldLabel of ["Blog", "Changelog", "Contact", "Docs"]) {
			expect(markup).not.toContain(oldLabel);
		}
		expect(markup).toContain('href="/#examples"');
		expect(markup).toContain('href="/#how-it-works"');
		expect(markup).toContain('href="https://app.configured.test/login"');
		expect(markup).toContain('href="https://app.configured.test/signup"');
		expect(markup).toContain('data-logo-label="EzPic"');
		expect(markup).not.toContain("data-locale-switch");
	});
});
