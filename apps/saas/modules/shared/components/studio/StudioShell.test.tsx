import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	pathname: "/",
	user: null as { id: string; isAnonymous?: boolean } | null,
}));
vi.mock("@auth/components/SessionProvider", () => ({
	SessionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: state.user }) }));
vi.mock("next/navigation", () => ({
	usePathname: () => state.pathname,
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@shared/hooks/use-media-query", () => ({ useIsMobile: () => false }));
vi.mock("@organizations/components/OrganizationSelect", () => ({ OrganzationSelect: () => null }));
vi.mock("../UserMenu", () => ({ UserMenu: () => <button>Account menu</button> }));
vi.mock("../NotificationCenter", () => ({ NotificationCenter: () => null }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: () => ({ data: null }),
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("@repo/ui/components/logo", () => ({ Logo: () => <span>EzPic</span> }));

import { StudioShell } from "./StudioShell";

const renderShell = () =>
	renderToStaticMarkup(
		<StudioShell>
			<main>Editor and inspiration</main>
		</StudioShell>,
	);

describe("homepage and signed-in tool navigation", () => {
	beforeEach(() => {
		state.pathname = "/";
		state.user = null;
	});

	it("renders the visitor homepage without a tool sidebar or drawer toggle", () => {
		const markup = renderShell();
		expect(markup).not.toContain('class="studio-sidebar"');
		expect(markup).not.toContain('aria-label="openNavigation"');
		expect(markup).toContain('data-workspace="false"');
		expect(markup).toContain('aria-label="EzPic"');
		expect(markup).toContain('href="/login"');
	});

	it("keeps the signed-in homepage without a sidebar and exposes the create entry", () => {
		state.user = { id: "owner" };
		const markup = renderShell();
		expect(markup).not.toContain('class="studio-sidebar"');
		expect(markup).toContain('href="/create"');
		expect(markup).toContain("Account menu");
	});

	it("shows the tool sidebar on the registered create page and links the logo home", () => {
		state.pathname = "/create";
		state.user = { id: "owner" };
		const markup = renderShell();
		expect(markup).toContain('class="studio-sidebar"');
		expect(markup).toContain('data-workspace="true"');
		expect(markup).toContain('aria-label="EzPic" href="/"');
		expect(markup).toContain('href="/history"');
	});

	it.each([null, { id: "guest", isAnonymous: true }])(
		"opens the same tool sidebar for a visitor without account controls (%j)",
		(user) => {
			state.pathname = "/create";
			state.user = user;
			const markup = renderShell();
			expect(markup).toContain('class="studio-sidebar"');
			expect(markup).toContain('href="/login');
			expect(markup).not.toContain("Account menu");
			expect(markup).not.toContain('href="/history"');
			expect(markup).not.toContain('href="/settings');
		},
	);
});
