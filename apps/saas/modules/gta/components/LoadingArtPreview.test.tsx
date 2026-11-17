import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	result: null as { assetId: string; prompt?: string; aspectRatio?: string } | null,
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: { id: "owner-1" } }) }));
vi.mock("../../christmas/lib/wallpaper-result-context", () => ({
	useWallpaperPreview: () => ({ result: mocks.result, source: "result", selectSource: vi.fn() }),
}));

import { buildGtaPrompt, defaultGtaSettings } from "../lib/config";
import { LoadingArtPreview } from "./LoadingArtPreview";

function render() {
	return renderToStaticMarkup(
		<LoadingArtPreview
			example={{
				src: "/images/gta/example.webp",
				alt: "Coastal illustration",
				width: 1600,
				height: 900,
			}}
			position="left"
			format="phone"
		/>,
	);
}

describe("loading art export composition", () => {
	beforeEach(() => {
		mocks.result = null;
	});
	it("uses the accepted task composition while a different next draft is selected", () => {
		mocks.result = {
			assetId: "output-1",
			prompt: buildGtaPrompt("loading-art", {
				...defaultGtaSettings("loading-art"),
				position: "right",
				format: "desktop",
			}),
		};
		const markup = render();
		expect(markup).toContain('data-format="desktop"');
		expect(markup).toContain('data-name-position="right"');
		expect(markup).toContain("Your loading-screen art");
	});
	it("keeps unrecognized historical task names in a bottom safe area", () => {
		mocks.result = { assetId: "old-output", prompt: "A coastal portrait", aspectRatio: "9:16" };
		const markup = render();
		expect(markup).toContain('data-format="phone"');
		expect(markup).toContain('data-name-position="bottom"');
	});
	it("allows a clean public preview with optional local name controls", () => {
		const markup = render();
		expect(markup).toContain('src="/images/gta/example.webp"');
		expect(markup).toContain('data-format="phone"');
		expect(markup).toContain('data-name-position="left"');
		expect(markup).toContain('aria-pressed="true">Clean image</button>');
		expect(markup).toContain("0/24");
		expect(markup).not.toContain("Your loading-screen art");
	});
});
