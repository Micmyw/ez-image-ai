import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/marketing.json";
import en from "../../../../../packages/i18n/translations/en/marketing.json";

const mocks = vi.hoisted(() => ({
	query: {} as Record<string, unknown>,
	source: "result" as "result" | "example",
}));
vi.mock("../lib/wallpaper-result-context", () => ({
	useWallpaperPreview: () => ({
		result: { assetId: "output-1" },
		source: mocks.source,
		selectSource: vi.fn(),
	}),
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: { id: "owner-1" } }) }));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useQuery: () => mocks.query,
}));

import { DEFAULT_WALLPAPER_SETTINGS } from "../lib/wallpaper";
import { WallpaperScreenPreview } from "./WallpaperScreenPreview";

function render(locale: "en" | "de" = "en") {
	return renderToStaticMarkup(
		<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
			<WallpaperScreenPreview settings={DEFAULT_WALLPAPER_SETTINGS} styleName="Cozy fireplace" />
		</NextIntlClientProvider>,
	);
}

describe("generated wallpaper screen preview", () => {
	beforeEach(() => {
		mocks.query = { data: { url: "https://private.test/output" }, isError: false };
		mocks.source = "result";
	});
	it("shows a selected example even when a generated result exists", () => {
		mocks.source = "example";
		const markup = render();
		expect(markup).toContain("/images/christmas/fireplace.webp");
		expect(markup).toContain("Cozy fireplace");
		expect(markup).not.toContain("https://private.test/output");
		expect(markup).toContain('aria-pressed="true">Style example</button>');
		expect(markup).toContain('aria-pressed="false">Your result</button>');
	});
	it("uses the authorized result and labels it independently of the selected style", () => {
		const markup = render();
		expect(markup).toContain('src="https://private.test/output"');
		expect(markup).toContain("Your Christmas wallpaper");
		expect(markup).not.toContain("Cozy fireplace");
		expect(markup).not.toContain("/images/christmas/");
	});
	it.each(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"])(
		"hides stale private data after %s",
		(code) => {
			mocks.query = { ...mocks.query, isError: true, error: { code } };
			const markup = render();
			expect(markup).not.toContain("https://private.test/output");
			expect(markup).toContain('role="alert"');
		},
	);
	it("retains an authorized preview through a temporary network error", () => {
		mocks.query = { ...mocks.query, isError: true, error: new TypeError("Network unavailable") };
		expect(render()).toContain('src="https://private.test/output"');
	});
	it("renders generated-result labels in a non-default locale", () => {
		expect(render("de")).toContain("Dein Weihnachtshintergrund");
	});
});
