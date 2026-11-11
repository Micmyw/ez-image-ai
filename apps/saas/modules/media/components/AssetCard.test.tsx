import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: { media: {} } }));

import { AssetCard } from "./AssetCard";

describe("image library tool entry", () => {
	it.each(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "video/mp4"])(
		"offers raster-only tools only for supported references (%s)",
		(mimeType) => {
			const html = renderToStaticMarkup(
				<AssetCard
					asset={{
						id: "selected-asset",
						kind: "OUTPUT",
						mimeType,
						byteSize: "42",
						createdAt: "2026-10-03T00:00:00Z",
						sourceJobId: null,
					}}
					onDeleted={vi.fn()}
				/>,
			);
			if (["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
				expect(html).toContain('href="/photo-to-coloring-page?asset=selected-asset#image-editor"');
				expect(html).toContain('href="/create?asset=selected-asset"');
			} else {
				expect(html).not.toContain("/photo-to-coloring-page?");
				expect(html).not.toContain("/create?asset=");
			}
			expect(html).toContain("download");
			expect(html).not.toContain("US Letter");
		},
	);
});
