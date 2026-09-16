import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../../../../packages/i18n/translations/en/saas.json";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { getAssetAccessUrl: vi.fn() } },
}));
vi.mock("../MediaUploader", () => ({ MediaUploader: () => <div /> }));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: keyof typeof messages.media.editor.source) =>
		messages.media.editor.source[key],
}));

import { ImageSourcePanel } from "./ImageSourcePanel";

describe("private input safety feedback", () => {
	it.each(["ASSET_CONTENT_NOT_ALLOWED", "ASSET_SAFETY_UNAVAILABLE"])(
		"stops polling and shows a readable no-charge message for %s",
		(code) => {
			const error = new Error(code);
			mocks.useQuery.mockReturnValue({ isError: true, error });
			const markup = renderToStaticMarkup(
				<ImageSourcePanel
					sourceAssetId="private-input"
					compact
					onChange={vi.fn()}
					onReadyChange={vi.fn()}
				/>,
			);
			expect(markup).toContain('role="alert"');
			expect(markup).toContain("No generation credits or one-time waiver were used.");
			expect(markup).not.toContain(code);
			expect(markup).not.toContain("<img");
			const options = mocks.useQuery.mock.calls.at(-1)![0];
			expect(options.refetchInterval({ state: { error } })).toBe(false);
			expect(options.refetchInterval({ state: { error: new Error("ASSET_SAFETY_PENDING") } })).toBe(
				2000,
			);
		},
	);
});
