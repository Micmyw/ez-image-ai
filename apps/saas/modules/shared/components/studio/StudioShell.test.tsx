import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	pathname: "/",
	search: "",
	user: null as { id: string; isAnonymous?: boolean } | null,
	loaded: true,
	creditBalance: "100",
	creditQueries: vi.fn(),
	videoAvailable: false,
	videoNavigationImported: vi.fn(),
	rumpelstiltskinNavigationImported: vi.fn(),
}));
vi.mock("@auth/components/SessionProvider", () => ({
	SessionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ loaded: state.loaded, user: state.user }),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => state.pathname,
	useSearchParams: () => new URLSearchParams(state.search),
	useRouter: () => ({ prefetch: vi.fn() }),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: { credits?: string }) =>
		key === "creditBalance" ? `creditBalance:${values?.credits}` : key,
}));
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
vi.mock("../../../video-v1/VideoNavigationLink", async (importOriginal) => {
	state.videoNavigationImported();
	return importOriginal();
});
vi.mock(
	"../../../video-effects/components/RumpelstiltskinNavigationLink",
	async (importOriginal) => {
		state.rumpelstiltskinNavigationImported();
		return importOriginal();
	},
);
vi.mock("../NotificationCenter", () => ({ NotificationCenter: () => null }));
vi.mock("./HeaderPurchaseActions", () => ({
	HeaderPurchaseActions: () => <div>Purchase actions</div>,
}));
vi.mock("../NavBar", () => ({ NavBar: () => <nav>Account navigation</nav> }));
vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>();
	const queryClient = new actual.QueryClient();
	return {
		...actual,
		useQueryClient: () => queryClient,
		useQuery: (options: { queryKey: readonly unknown[] }) => {
			if (options.queryKey[0] === "media-credit-account") {
				state.creditQueries(options);
				return { data: { spendableCredits: state.creditBalance } };
			}
			return {
				data: {
					available: state.videoAvailable,
					products: [{ key: "image-gpt-image-2", skuMatrix: { cells: [{}] } }],
				},
			};
		},
	};
});
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
		state.search = "";
		state.user = null;
		state.loaded = true;
		state.creditBalance = "100";
		state.creditQueries.mockClear();
		state.videoAvailable = false;
	});

	it.each([
		["/video-effects/hotel-lobby-ai", "", "/video-effects/hotel-lobby-ai"],
		["/blog/raindance-ai-trend", "mode=duo", "/blog/raindance-ai-trend?mode=duo"],
		[
			"/blog/raindance-ai-trend",
			"job=private-job_1&mode=duo&asset=private-url&redirectTo=https://evil.example",
			"/blog/raindance-ai-trend?job=private-job_1&mode=duo",
		],
	])(
		"returns header sign-in to %s with safe template state",
		async (pathname, search, expected) => {
			state.pathname = pathname;
			state.search = search;
			const markup = await renderShell();
			expect(markup).toContain(`href="/login?redirectTo=${encodeURIComponent(expected)}"`);
			expect(markup).not.toContain("evil.example");
			expect(markup).not.toContain("private-url");
		},
	);

	it.each([null, { id: "guest", isAnonymous: true }])(
		"does not import video navigation or its catalog for a homepage visitor (%j)",
		async (user) => {
			state.user = user;
			expect(state.videoNavigationImported).not.toHaveBeenCalled();
			expect(state.rumpelstiltskinNavigationImported).not.toHaveBeenCalled();
			const markup = await renderShell();
			expect(markup).not.toContain('href="/video"');
			expect(markup).not.toContain('href="/video/effects/rumpelstiltskin"');
			expect(state.videoNavigationImported).not.toHaveBeenCalled();
			expect(state.rumpelstiltskinNavigationImported).not.toHaveBeenCalled();
		},
	);

	it("loads video navigation for a registered user only when its catalog grants access", async () => {
		state.pathname = "/create";
		state.user = { id: "owner" };
		state.videoAvailable = true;
		const markup = await renderShell();
		expect(state.videoNavigationImported).toHaveBeenCalled();
		expect(markup).toContain('href="/video"');
	});

	it("switches sidebar balances to the current session owner's query", async () => {
		state.pathname = "/create";
		state.user = { id: "A" };
		expect(await renderShell()).toContain("creditBalance:100");
		expect(state.creditQueries).toHaveBeenLastCalledWith(
			expect.objectContaining({
				queryKey: ["media-credit-account", "A"],
				enabled: true,
			}),
		);
		state.user = { id: "B" };
		state.creditBalance = "20";
		const markup = await renderShell();
		expect(markup).toContain("creditBalance:20");
		expect(markup).not.toContain("creditBalance:100");
		expect(state.creditQueries).toHaveBeenLastCalledWith(
			expect.objectContaining({
				queryKey: ["media-credit-account", "B"],
				enabled: true,
			}),
		);
	});

	it("disables sidebar credits and hides old balance until the session is loaded", async () => {
		state.pathname = "/create";
		state.user = { id: "A" };
		state.loaded = false;
		const markup = await renderShell();
		expect(markup).not.toContain("creditBalance:100");
		expect(state.creditQueries).toHaveBeenLastCalledWith(
			expect.objectContaining({
				queryKey: ["media-credit-account", null],
				enabled: false,
			}),
		);
	});

	it.each([null, { id: "guest", isAnonymous: true }])(
		"never queries or shows account credits for an unauthenticated sidebar (%j)",
		async (user) => {
			state.pathname = "/create";
			state.user = user;
			expect(await renderShell()).not.toContain("creditBalance:100");
			expect(state.creditQueries).not.toHaveBeenCalled();
		},
	);

	it("keeps the deferred video link hidden when the registered user has no catalog access", async () => {
		state.pathname = "/create";
		state.user = { id: "owner" };
		const markup = await renderShell();
		expect(markup).not.toContain('href="/video"');
		expect(markup).toContain('href="/video/effects/rumpelstiltskin"');
		expect(state.rumpelstiltskinNavigationImported).toHaveBeenCalled();
	});
	it("marks the registered Rumpelstiltskin entry active on its account page", async () => {
		state.pathname = "/video/effects/rumpelstiltskin";
		state.user = { id: "customer" };
		const markup = await renderShell();
		expect(markup).toMatch(
			/class="studio-nav-link is-active"[^>]*href="\/video\/effects\/rumpelstiltskin"/,
		);
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

	it.each(["/history", "/settings/general"])(
		"server-renders the deferred workspace shell and content through AppWrapper on %s",
		async (pathname) => {
			state.pathname = pathname;
			state.user = { id: "owner" };
			const stream = await renderToReadableStream(
				<AppWrapper>
					<main>Workspace account content</main>
				</AppWrapper>,
			);
			const markup = await new Response(stream).text();
			expect(markup).toContain('data-studio-shell=""');
			expect(markup).toContain('class="studio-sidebar"');
			expect(markup).toContain("Workspace account content");
			expect(markup).toContain('href="/history"');
			expect(markup).not.toContain("BAILOUT_TO_CLIENT_SIDE_RENDERING");
		},
	);

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
			expect(markup).not.toContain('href="/video/effects/rumpelstiltskin"');
		},
	);
});
