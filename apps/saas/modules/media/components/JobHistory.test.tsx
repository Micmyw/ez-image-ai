import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/components/badge", () => ({
	Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("@repo/ui/components/select", () => {
	const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
	return {
		Select: Container,
		SelectContent: Container,
		SelectItem: Container,
		SelectTrigger: Container,
		SelectValue: () => null,
	};
});
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
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
		if (namespace === "media.history" && key === "legacyProduct") return "Legacy edit";
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
						job("job-legacy", "image-quality", "gpt-image-2-2k", "1:1"),
						job("job-video", "video-fast", null, null),
					],
				},
			],
		},
		isLoading: false,
		hasNextPage: false,
	}),
}));

import { JobHistory } from "./JobHistory";

describe("JobHistory", () => {
	it("shows a representative public-model subset and safe SKU specs while keeping legacy edits read-only", () => {
		const visibleText = renderToStaticMarkup(<JobHistory />).replaceAll(/<[^>]+>/g, " ");

		for (const copy of [
			"Nano Banana 2 Lite",
			"GPT Image 2",
			"Seedream 5 Pro",
			"1K",
			"4K",
			"2K · High",
			"16:9",
			"9:16",
			"Legacy edit",
		]) {
			expect(visibleText).toContain(copy);
		}
		expect(visibleText).not.toMatch(
			/image-nano|image-gpt|image-seedream|image-quality|nano-banana-2-lite-1k|provider|cost|kie|video/i,
		);
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
		outputCount: 1,
		creditsReserved: "4",
	};
}
