import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useEditSessions: vi.fn() }));

vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		({
			title: "Edit sessions",
			subtitle: "Continue private image revisions.",
			untitled: "Untitled edit",
			versions: `${typeof values?.count === "number" ? values.count : 0} versions`,
			empty: "No edit sessions yet.",
			more: "Load more",
		})[key] ?? key,
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("../../hooks/use-edit-sessions", () => ({
	useEditSessions: mocks.useEditSessions,
}));

import { EditSessionList } from "./EditSessionList";

describe("EditSessionList", () => {
	beforeEach(() => {
		mocks.useEditSessions.mockReturnValue({
			data: {
				pages: [
					{
						items: [
							{
								id: "session-2",
								title: "Hero refinements",
								versionCount: 3,
								updatedAt: "2026-08-25T02:00:00.000Z",
							},
							{
								id: "session-1",
								title: null,
								versionCount: 1,
								updatedAt: "2026-08-25T01:00:00.000Z",
							},
						],
					},
				],
			},
			isLoading: false,
			hasNextPage: true,
			isFetchingNextPage: false,
			fetchNextPage: vi.fn(),
		});
	});

	it("renders owner-scoped sessions in API order with stable detail links", () => {
		const markup = renderToStaticMarkup(<EditSessionList />);

		expect(markup).toContain("Hero refinements");
		expect(markup).toContain("Untitled edit");
		expect(markup).toContain("3 versions");
		expect(markup).toContain('href="/edits/session-2"');
		expect(markup).toContain('href="/edits/session-1"');
		expect(markup).toContain("Load more");
		expect(markup).not.toMatch(/provider|model|video|text-to-image|cost/i);
	});
});
