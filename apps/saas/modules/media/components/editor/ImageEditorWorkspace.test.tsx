vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: { id: "owner-a" } }) }));
import React from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attribution = vi.hoisted(() => ({
	clearActive: vi.fn(),
	commitEffects: [] as Array<() => void>,
	effect: null as { selectedPreset: { id: string } } | null,
}));
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useLayoutEffect: (callback: () => void) => {
		attribution.commitEffects.push(callback);
	},
}));
vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	clearBrowserGrowthActiveContentAttribution: attribution.clearActive,
}));
vi.mock("../../../effects/lib/editor-context", () => ({
	useEffectEditor: () => attribution.effect,
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
// Exercise the same lazy SSR implementation used by the App Router compiler.
vi.mock("next/dynamic", async () => ({
	default: (await import("next/dist/shared/lib/app-dynamic")).default,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => navigation.pathname,
	useSearchParams: () => filters,
}));
const filters = vi.hoisted(() => new URLSearchParams());
const navigation = vi.hoisted(() => ({ pathname: "/create" }));
vi.mock("@payments/lib/editor-upgrade", () => ({ readEditorUpgradeDraft: vi.fn() }));
vi.mock("@shared/lib/growth-analytics", () => ({ saasGrowthFunnel: { draftClaimed: vi.fn() } }));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("../GenerationForm", () => ({
	GenerationForm: ({
		requireReference = false,
		layout,
	}: {
		requireReference?: boolean;
		layout?: string;
	}) => (
		<div
			data-testid="generation-form"
			data-require-reference={requireReference}
			data-layout={layout}
		>
			form
		</div>
	),
}));
vi.mock("../RecentJobQueue", () => ({
	RecentJobQueue: () => <div data-testid="recent-edits">recent</div>,
}));
vi.mock("./EditorResultPanel", () => ({
	EditorResultPanel: () => <div data-testid="result-panel">result</div>,
}));

import { CreatorWorkspace } from "../CreatorWorkspace";
import { ImageEditorWorkspace } from "./ImageEditorWorkspace";

describe("ImageEditorWorkspace responsive composition", () => {
	beforeEach(() => {
		attribution.clearActive.mockClear();
		attribution.commitEffects = [];
		attribution.effect = null;
	});
	it.each(["/create", "/image-to-image", "/models/gpt-image-2"])(
		"clears active content on entering the ordinary registered editor at %s",
		(pathname) => {
			navigation.pathname = pathname;
			try {
				renderToStaticMarkup(
					<ImageEditorWorkspace
						allowedProductKeys={["image-nano-banana-2-lite"]}
						restoreState="idle"
						restoreNotice={null}
					/>,
				);
				for (const commit of attribution.commitEffects) commit();
				expect(attribution.clearActive).toHaveBeenCalledOnce();
			} finally {
				navigation.pathname = "/create";
			}
		},
	);
	it("retains the current preset scope in an article editor", () => {
		attribution.effect = { selectedPreset: { id: "studio-portrait" } };
		navigation.pathname = "/blog/1980s-ai-photo";
		try {
			renderToStaticMarkup(
				<ImageEditorWorkspace
					allowedProductKeys={["image-nano-banana-2-lite"]}
					restoreState="idle"
					restoreNotice={null}
				/>,
			);
			for (const commit of attribution.commitEffects) commit();
			expect(attribution.clearActive).not.toHaveBeenCalled();
		} finally {
			navigation.pathname = "/create";
			attribution.effect = null;
		}
	});
	it.each([
		["/", "default"],
		["/image-to-image", "minimal"],
		["/create", "default"],
	])("preserves the existing %s composer layout (%s)", (pathname, layout) => {
		navigation.pathname = pathname;
		try {
			const markup = renderToStaticMarkup(
				<ImageEditorWorkspace
					allowedProductKeys={["image-nano-banana-2-lite"]}
					restoreState="idle"
					restoreNotice={null}
				/>,
			);
			expect(markup).toContain(`data-layout="${layout}"`);
		} finally {
			navigation.pathname = "/create";
		}
	});
	it("keeps the streamlined preset layout inside the article editor", () => {
		attribution.effect = { selectedPreset: { id: "studio-portrait" } };
		navigation.pathname = "/blog/1980s-ai-photo";
		try {
			const markup = renderToStaticMarkup(
				<ImageEditorWorkspace
					allowedProductKeys={["image-nano-banana-2-lite"]}
					restoreState="idle"
					restoreNotice={null}
				/>,
			);
			expect(markup).toContain('data-layout="minimal"');
		} finally {
			navigation.pathname = "/create";
		}
	});
	it("passes an effect's required-reference constraint through the existing workspace", () => {
		const markup = renderToStaticMarkup(
			<ImageEditorWorkspace
				requireReference
				allowedProductKeys={["image-nano-banana-2-lite"]}
				restoreState="idle"
				restoreNotice={null}
			/>,
		);
		expect(markup).toContain('data-testid="generation-form" data-require-reference="true"');
	});
	it("allows prompt-only creation on the image-to-image page", () => {
		navigation.pathname = "/image-to-image";
		try {
			const markup = renderToStaticMarkup(
				<ImageEditorWorkspace
					allowedProductKeys={["image-nano-banana-2-lite"]}
					restoreState="idle"
					restoreNotice={null}
				/>,
			);
			expect(markup).toContain('data-testid="generation-form" data-require-reference="false"');
		} finally {
			navigation.pathname = "/create";
		}
	});

	it("server-renders the signed-in editor through its lazy entry", async () => {
		const stream = await renderToReadableStream(
			<CreatorWorkspace
				allowedProductKeys={["image-nano-banana-2-lite"]}
				restoreState="idle"
				restoreNotice={null}
			/>,
		);
		const markup = await new Response(stream).text();
		expect(markup).toContain('data-testid="generation-form"');
		expect(markup).toContain('data-testid="recent-edits"');
	});
	it("gives an empty editor the full creation surface without a permanent result placeholder", () => {
		const markup = renderToStaticMarkup(
			<ImageEditorWorkspace
				allowedProductKeys={[
					"image-nano-banana-2-lite",
					"image-gpt-image-2",
					"image-seedream-5-pro",
				]}
				restoreState="idle"
				restoreNotice={null}
			/>,
		);

		expect(markup).not.toContain('data-testid="result-panel"');
		expect(markup.indexOf('data-testid="generation-form"')).toBeLessThan(
			markup.indexOf('data-testid="recent-edits"'),
		);
	});
	it("shows a selected job after the editor in the same page", () => {
		filters.set("job", "current-job");
		try {
			const markup = renderToStaticMarkup(
				<ImageEditorWorkspace
					allowedProductKeys={["image-nano-banana-2-lite"]}
					restoreState="idle"
					restoreNotice={null}
				/>,
			);
			expect(markup).toContain('data-testid="result-panel"');
			expect(markup).toContain("workspace.closePreview");
			expect(markup.indexOf('data-testid="generation-form"')).toBeLessThan(
				markup.indexOf('data-testid="result-panel"'),
			);
		} finally {
			filters.delete("job");
		}
	});
});
