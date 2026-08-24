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
			return key === "image-fast.label" ? "Standard Edit" : "Quality Edit";
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
						job("job-standard", "image-fast"),
						job("job-quality", "image-quality"),
						job("job-video", "video-fast"),
					],
				},
			],
		},
	}),
}));

import { RecentJobQueue } from "./RecentJobQueue";

describe("RecentJobQueue", () => {
	it("shows only friendly Standard and Quality edit labels in the editor", () => {
		const markup = renderToStaticMarkup(<RecentJobQueue selectedJobId={null} onSelect={vi.fn()} />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Standard Edit");
		expect(visibleText).toContain("Quality Edit");
		expect(visibleText).not.toMatch(/image-fast|image-quality|video/i);
	});
});

function job(id: string, productKey: string) {
	return {
		id,
		productKey,
		status: "SUCCEEDED",
		createdAt: "2026-08-25T00:00:00.000Z",
	};
}
