import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/components/badge", () => ({
	Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => {
		if (namespace === "media.create.products") {
			const products: Record<string, string> = {
				"image-nano-banana-2-lite.label": "Nano Banana 2 Lite",
				"image-gpt-image-2.label": "GPT Image 2",
				"image-seedream-5-pro.label": "Seedream 5 Pro",
			};
			return products[key] ?? key;
		}
		if (namespace === "media.create.skus") {
			const skus: Record<string, string> = {
				"nano-banana-2-lite-1k.label": "1K",
				"gpt-image-2-4k.label": "4K",
				"seedream-5-pro-high-2k.label": "2K · High",
			};
			return skus[key] ?? key;
		}
		return key;
	},
}));
vi.mock("../hooks/use-job-history", () => ({
	useJobHistory: () => ({
		data: {
			pages: [
				{
					items: [
						job("job-nano", "image-nano-banana-2-lite", "nano-banana-2-lite-1k", "auto"),
						job("job-gpt", "image-gpt-image-2", "gpt-image-2-4k", "16:9"),
						job("job-seedream", "image-seedream-5-pro", "seedream-5-pro-high-2k", "9:16"),
						job("job-retired", "image-quality", "gpt-image-2-2k", "1:1"),
						job("job-video", "video-fast", null, null),
					],
				},
			],
		},
	}),
}));

import { RecentJobQueue } from "./RecentJobQueue";

describe("RecentJobQueue", () => {
	it("shows only current public models and their safe SKU selections in the editor", () => {
		const markup = renderToStaticMarkup(<RecentJobQueue selectedJobId={null} onSelect={vi.fn()} />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		for (const copy of [
			"Nano Banana 2 Lite",
			"GPT Image 2",
			"Seedream 5 Pro",
			"1K",
			"4K",
			"2K · High",
			"16:9",
			"9:16",
		]) {
			expect(visibleText).toContain(copy);
		}
		expect(visibleText).not.toMatch(/image-quality|gpt-image-2-2k|provider|cost|kie|video/i);
	});
});

function job(id: string, productKey: string, skuKey: string | null, aspectRatio: string | null) {
	return {
		id,
		productKey,
		skuKey,
		aspectRatio,
		status: "SUCCEEDED",
		createdAt: "2026-08-25T00:00:00.000Z",
	};
}
