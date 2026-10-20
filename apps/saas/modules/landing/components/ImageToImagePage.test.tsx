import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock("@auth/lib/server", () => ({ getSession: session }));
vi.mock("@shared/lib/base-url", () => ({ getBaseUrl: () => "https://ezimageai.test" }));
vi.mock("next-intl/server", () => ({
	getTranslations: async () => (key: string) => key,
	getLocale: async () => "en",
}));
vi.mock("@shared/components/studio/StudioShell", () => ({
	StudioShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@shared/components/RegisteredWorkspaceBoundary", () => ({
	RegisteredWorkspaceBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@shared/components/MainAccountBoundary", () => ({
	MainAccountBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@media/components/editor/RegisteredEditor", () => ({
	RegisteredEditor: () => <div data-registered-editor="" />,
}));
vi.mock("./LandingGenerator", () => ({
	LandingGenerator: () => <div data-guest-editor="" />,
}));
vi.mock("./ImageToImageExamples", () => ({
	ImageToImageExamples: () => <section id="image-to-image-examples">Public examples</section>,
}));
vi.mock("../../public-content/components/PhotoIdeaRecommendations", () => ({
	PhotoIdeaRecommendations: () => null,
}));
vi.mock("../../public-content/components/PublicFooterLinks", () => ({
	PublicFooterLinks: () => null,
}));

import { ImageToImagePage } from "./ImageToImagePage";

describe("image-to-image page streaming", () => {
	beforeEach(() => session.mockReset());

	it("streams public copy and examples while the account session is still pending", async () => {
		let finishSession!: (value: unknown) => void;
		session.mockReturnValue(
			new Promise((resolve) => {
				finishSession = resolve;
			}),
		);
		const page = ImageToImagePage({});
		let pageReady = false;
		void page.then(() => {
			pageReady = true;
		});
		let stream: Awaited<ReturnType<typeof renderToReadableStream>> | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			// This fails if the page awaits the session before returning its Suspense boundary.
			await vi.waitFor(() => expect(pageReady).toBe(true));
			stream = await renderToReadableStream(await page);
			reader = stream.getReader();
			const decoder = new TextDecoder();
			let shell = "";
			while (!shell.includes('id="image-to-image-examples"')) {
				const chunk = await reader.read();
				if (chunk.done) break;
				shell += decoder.decode(chunk.value, { stream: true });
			}
			expect(session).toHaveBeenCalledOnce();
			expect(shell).toContain("data-image-to-image-page");
			expect(shell).toContain("<h1");
			expect(shell).toContain("Public examples");
			expect(shell).toContain("loading");
			expect(shell).not.toContain("data-guest-editor");
			expect(shell).not.toContain("data-registered-editor");

			finishSession(null);
			let continuation = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				continuation += decoder.decode(chunk.value, { stream: true });
			}
			expect(continuation).toContain("data-guest-editor");
		} finally {
			finishSession(null);
			await page;
			await stream?.allReady;
			reader?.releaseLock();
		}
	});
});
