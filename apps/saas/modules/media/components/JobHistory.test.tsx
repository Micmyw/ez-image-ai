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
		isLoading: false,
		hasNextPage: false,
	}),
}));

import { JobHistory } from "./JobHistory";

describe("JobHistory", () => {
	it("shows only EzPic edit jobs with friendly public mode labels", () => {
		const visibleText = renderToStaticMarkup(<JobHistory />).replaceAll(/<[^>]+>/g, " ");

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
		outputCount: 1,
		creditsReserved: "4",
	};
}
