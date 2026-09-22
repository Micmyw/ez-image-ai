import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
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
	useRouter: () => ({ prefetch: vi.fn() }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
// Next's App Router aliases next/dynamic to this implementation during a build.
vi.mock("next/dynamic", async () => ({
	default: (await import("next/dist/shared/lib/app-dynamic")).default,
}));
vi.mock("@shared/hooks/use-media-query", () => ({
	useIsMobile: () => false,
	useMediaQuery: () => false,
}));
vi.mock("@organizations/components/OrganizationSelect", () => ({ OrganzationSelect: () => null }));
vi.mock("../UserMenu", () => ({ UserMenu: () => <button>Account menu</button> }));
vi.mock("../NotificationCenter", () => ({ NotificationCenter: () => null }));
vi.mock("./HeaderPurchaseActions", () => ({
	HeaderPurchaseActions: () => <div>Purchase actions</div>,
}));
vi.mock("../NavBar", () => ({ NavBar: () => <nav>Account navigation</nav> }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: () => ({
		data: { products: [{ key: "image-gpt-image-2", skuMatrix: { cells: [{}] } }] },
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("@repo/ui/components/logo", () => ({ Logo: () => <span>EzImageAI</span> }));

import { AppWrapper } from "../AppWrapper";
import { StudioShell } from "./StudioShell";

const renderShell = async () => {
	const stream = await renderToReadableStream(
		<StudioShell>
			<main>Editor and inspiration</main>
		</StudioShell>,
	);
	return new Response(stream).text();
};

describe("homepage and signed-in tool navigation", () => {
	beforeEach(() => {
		state.pathname = "/";
		state.user = null;
	});

	it("opens a model page from the create sidebar instead of only changing the form query", async () => {
		state.pathname = "/create";
		state.user = { id: "owner" };
		const markup = await renderShell();
		expect(markup).toContain('href="/models/gpt-image-2"');
		expect(markup).not.toContain('href="/create?model=');
	});

	it("gives Create image a real workspace destination on model pages", async () => {
		state.pathname = "/models/gpt-image-2";
		state.user = { id: "owner" };
		const markup = await renderShell();
		const sidebar = markup.match(/<aside class="studio-sidebar"[\s\S]*?<\/aside>/)?.[0];
		expect(sidebar).toContain('href="/create"');
		expect(sidebar).not.toContain('href="#image-editor"');
	});

	it("separates editing examples from the create page", async () => {
		state.pathname = "/create";
		const markup = await renderShell();
		expect(markup.includes('href="/examples"')).toBe(true);
		expect(markup.includes('href="/create#examples"')).toBe(false);
	});

	it("keeps a compact navigation entry available on the visitor homepage without a tool sidebar", async () => {
		const markup = await renderShell();
		expect(markup).not.toContain('class="studio-sidebar"');
		expect(markup).toContain('data-test="header-navigation-trigger"');
		expect(markup).toContain('aria-label="openNavigation"');
		expect(markup).toContain('data-workspace="false"');
		expect(markup).toContain('aria-label="EzImageAI"');
		expect(markup).toContain('href="/login"');
	});

	it("keeps the signed-in homepage without a sidebar and exposes the create entry", async () => {
		state.user = { id: "owner" };
		const markup = await renderShell();
		expect(markup).not.toContain('class="studio-sidebar"');
		expect(markup).toContain('href="/create"');
		expect(markup).toContain("Account menu");
	});

	it("shows the tool sidebar on the registered create page and links the logo home", async () => {
		state.pathname = "/create";
		state.user = { id: "owner" };
		const markup = await renderShell();
		expect(markup).toContain('class="studio-sidebar"');
		expect(markup).toContain('data-workspace="true"');
		expect(markup).toContain('aria-label="EzImageAI" href="/"');
		expect(markup).toContain('href="/history"');
	});
	it("server-renders account navigation through the shared error-page wrapper", async () => {
		state.pathname = "/admin/users";
		const stream = await renderToReadableStream(
			<AppWrapper>
				<main>Account content</main>
			</AppWrapper>,
		);
		const markup = await new Response(stream).text();
		expect(markup).toContain("Account navigation");
		expect(markup).toContain("Account content");
	});

	it.each([null, { id: "guest", isAnonymous: true }])(
		"opens the same tool sidebar for a visitor without account controls (%j)",
		async (user) => {
			state.pathname = "/create";
			state.user = user;
			const markup = await renderShell();
			expect(markup).toContain('class="studio-sidebar"');
			expect(markup).toContain('href="/login');
			expect(markup).not.toContain("Account menu");
			expect(markup).not.toContain('href="/history"');
			expect(markup).not.toContain('href="/settings');
		},
	);
});
