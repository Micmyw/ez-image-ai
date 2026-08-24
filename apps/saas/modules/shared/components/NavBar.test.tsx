import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user_1", role: "user" } }),
}));
vi.mock("@organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ activeOrganization: null, isOrganizationAdmin: false }),
}));
vi.mock("@repo/auth/config", () => ({
	config: { organizations: { enable: false, hideOrganization: true } },
}));
vi.mock("@repo/payments/config", () => ({ config: { billingAttachedTo: "user" } }));

vi.mock("@repo/ui", async () => {
	const ReactModule = await import("react");
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactModule.createElement(ReactModule.Fragment, null, children);
	return {
		Button: ({ children }: { children?: React.ReactNode }) =>
			ReactModule.createElement("button", null, children),
		cn: (...values: unknown[]) => values.filter((value) => typeof value === "string").join(" "),
		mergeTriggerProps: (first: object, second: object) => ({ ...first, ...second }),
		DropdownMenu: Container,
		DropdownMenuContent: Container,
		DropdownMenuGroup: Container,
		DropdownMenuItem: Container,
		DropdownMenuLabel: Container,
		DropdownMenuTrigger: Container,
		Logo: ({ label }: { label?: string }) =>
			ReactModule.createElement("span", { "data-logo-label": label }),
		Sheet: Container,
		SheetContent: Container,
		SheetHeader: Container,
		SheetTitle: Container,
		SheetTrigger: ({ render }: { render?: React.ReactNode }) =>
			ReactModule.createElement(ReactModule.Fragment, null, render),
	};
});
vi.mock("@repo/ui/components/tooltip", async () => {
	const ReactModule = await import("react");
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactModule.createElement(ReactModule.Fragment, null, children);
	return {
		Tooltip: Container,
		TooltipContent: Container,
		TooltipProvider: Container,
		TooltipTrigger: Container,
	};
});
vi.mock("@shared/components/NotificationCenter", () => ({ NotificationCenter: () => null }));
vi.mock("@shared/components/UserMenu", () => ({ UserMenu: () => null }));
vi.mock("../../organizations/components/OrganizationSelect", () => ({
	OrganzationSelect: () => null,
}));
vi.mock("../hooks/use-media-query", () => ({ useIsMobile: () => false }));
vi.mock("../lib/sidebar-context", () => ({
	useSidebar: () => ({ isCollapsed: false, toggleCollapsed: vi.fn() }),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			"app.menu.create": "Create",
			"app.menu.history": "History",
			"app.menu.assets": "Assets",
			"app.menu.aiChatbot": "AI Chatbot",
			"app.menu.accountSettings": "Settings",
			"settings.menu.account.general": "General",
			"settings.menu.account.security": "Security",
			"settings.menu.account.notifications": "Notifications",
			"settings.menu.account.billing": "Billing",
		})[key] ?? key,
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/general" }));

import { NavBar } from "./NavBar";

describe("SaaS navigation", () => {
	it("shows the EzPic editor destinations without the chatbot example", () => {
		const markup = renderToStaticMarkup(<NavBar />);

		for (const label of ["Create", "History", "Assets", "Settings", "Billing"]) {
			expect(markup).toContain(label);
		}
		for (const href of [
			"/create",
			"/history",
			"/assets",
			"/settings/general",
			"/settings/billing",
		]) {
			expect(markup).toContain(`href="${href}"`);
		}
		expect(markup).not.toContain("AI Chatbot");
		expect(markup).not.toContain('href="/chatbot"');
		expect(markup).not.toContain("lucide-clapperboard");
		expect(markup).toContain("lucide-image-plus");
		expect(markup).toContain('data-logo-label="EzPic"');
	});
});
