import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const useAssets = vi.hoisted(() => vi.fn());

vi.mock("../hooks/use-assets", () => ({ useAssets }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams("kind=video"),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			title: "Asset library",
			subtitle: "Private source images and edited outputs.",
			"filters.all": "All assets",
			"filters.image": "Images",
			"filters.video": "Videos",
			empty: "No images yet.",
			more: "Load more",
		})[key] ?? key,
}));

import { AssetLibrary } from "./AssetLibrary";

describe("EzPic asset library", () => {
	it("queries and exposes image assets only", () => {
		useAssets.mockReturnValue({
			data: { pages: [{ items: [] }] },
			fetchNextPage: vi.fn(),
			hasNextPage: false,
			isFetchingNextPage: false,
			isLoading: false,
			refetch: vi.fn(),
		});

		const markup = renderToStaticMarkup(<AssetLibrary />);

		expect(useAssets).toHaveBeenCalledWith("image");
		expect(markup).not.toContain("Videos");
	});
});
