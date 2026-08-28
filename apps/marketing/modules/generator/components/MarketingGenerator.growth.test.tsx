import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authHandoffStarted: vi.fn((_attemptKey: string, _productKey: string) => Promise.resolve("sent")),
	createMarketingDraft: vi.fn(),
	marketingDraftCreated: vi.fn((_attemptKey: string, _productKey: string) =>
		Promise.resolve("sent"),
	),
	sourceUploadCompleted: vi.fn((_attemptKey: string, _productKey: string) =>
		Promise.resolve("sent"),
	),
	sourceUploadStarted: vi.fn((_attemptKey: string, _productKey: string) => Promise.resolve("sent")),
	submitMarketingDraftHandoff: vi.fn(),
	uploadGuestDraft: vi.fn(),
}));

const reactState = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useEffect: vi.fn(),
		useRef: <T,>(initial: T) => ({ current: initial }),
		useState: <T,>(initial: T) => {
			const index = reactState.index++;
			const value = index < reactState.values.length ? reactState.values[index] : initial;
			return [value as T, vi.fn()] as const;
		},
	};
});
vi.mock("@analytics", () => ({
	marketingGrowthFunnel: {
		authHandoffStarted: mocks.authHandoffStarted,
		marketingDraftCreated: mocks.marketingDraftCreated,
		sourceUploadCompleted: mocks.sourceUploadCompleted,
		sourceUploadStarted: mocks.sourceUploadStarted,
	},
}));
vi.mock("@config", () => ({ config: { saasUrl: "https://app.configured.test" } }));
vi.mock("@i18n/routing", () => ({
	LocaleLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
vi.mock("@repo/config/client", () => ({
	getPublicConfig: () => ({ uploadLimits: { imageBytes: 20 * 1024 * 1024 } }),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));
vi.mock("../lib/draft-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/draft-client")>();
	return {
		...actual,
		createMarketingDraft: mocks.createMarketingDraft,
		submitMarketingDraftHandoff: mocks.submitMarketingDraftHandoff,
	};
});
vi.mock("../lib/guest-upload-client", () => ({ uploadGuestDraft: mocks.uploadGuestDraft }));

import { ImageDropzone } from "../../image-editor/components/ImageDropzone";
import { MarketingGenerator } from "./MarketingGenerator";

const modes = {
	"image-fast": { credits: 4, label: "Standard Edit" },
	"image-quality": { credits: 10, label: "Quality Edit" },
} as const;
const capability = {
	version: "guest-v12",
	enabled: true,
	reason: null,
	upload: {
		mimeTypes: ["image/jpeg", "image/png", "image/webp"],
		maximumBytes: 10 * 1024 * 1024,
	},
	product: { key: "image-fast", label: "Standard Edit", credits: "4" },
	queueEstimate: { kind: "capacity" as const },
} as const;

describe("MarketingGenerator growth events", () => {
	beforeEach(() => {
		reactState.index = 0;
		reactState.values = [];
		vi.clearAllMocks();
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
	});

	it("tracks upload start and valid completion with one opaque attempt key", () => {
		const tree = MarketingGenerator({ modes, capability });
		const dropzone = findElement(tree, (element) => element.type === ImageDropzone);

		expect(dropzone?.props.onUploadStarted).toBeTypeOf("function");
		(dropzone?.props.onUploadStarted as (() => void) | undefined)?.();
		(
			dropzone?.props.onFile as
				| ((file: { name: string; size: number; type: string }) => void)
				| undefined
		)?.({ name: "private-photo.png", size: 12, type: "image/png" });

		expect(mocks.sourceUploadStarted).toHaveBeenCalledWith(expect.any(String), "image-fast");
		const attemptKey = mocks.sourceUploadStarted.mock.calls[0]?.[0];
		expect(mocks.sourceUploadCompleted).toHaveBeenCalledWith(attemptKey, "image-fast");
		expect(JSON.stringify(mocks.sourceUploadStarted.mock.calls)).not.toContain("private-photo.png");
		expect(JSON.stringify(mocks.sourceUploadCompleted.mock.calls)).not.toContain(
			"private-photo.png",
		);
	});

	it("tracks draft creation and auth handoff only after the draft succeeds", async () => {
		const sourceFile = { name: "private-photo.png", size: 12, type: "image/png" };
		reactState.values = [
			"safe edit instruction",
			false,
			undefined,
			sourceFile,
			undefined,
			undefined,
			capability,
			false,
			undefined,
			"turnstile-proof",
		];
		mocks.uploadGuestDraft.mockResolvedValue({
			action: "https://app.configured.test/draft/continue",
			claimToken: "a".repeat(43),
		});

		const tree = MarketingGenerator({ modes, capability });
		const form = findElement(tree, (element) => element.type === "form");
		expect(form).toBeDefined();
		(form?.props.onSubmit as ((event: { preventDefault: () => void }) => void) | undefined)?.({
			preventDefault: vi.fn(),
		});

		await vi.waitFor(() => expect(mocks.submitMarketingDraftHandoff).toHaveBeenCalledOnce());
		const attemptKey = mocks.marketingDraftCreated.mock.calls[0]?.[0];
		expect(mocks.marketingDraftCreated).toHaveBeenCalledWith(attemptKey, "image-fast");
		expect(mocks.authHandoffStarted).toHaveBeenCalledWith(attemptKey, "image-fast");
		expect(mocks.uploadGuestDraft.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.marketingDraftCreated.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.marketingDraftCreated.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.authHandoffStarted.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.authHandoffStarted.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.submitMarketingDraftHandoff.mock.invocationCallOrder[0] ?? 0,
		);
		expect(JSON.stringify(mocks.marketingDraftCreated.mock.calls)).not.toContain(
			"private-photo.png",
		);
		expect(JSON.stringify(mocks.authHandoffStarted.mock.calls)).not.toContain("a".repeat(43));
	});
});

function findElement(
	node: ReactNode,
	predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (predicate(node)) return node;
	const children = (node.props as { children?: ReactNode }).children;
	return React.Children.toArray(children)
		.map((child) => findElement(child, predicate))
		.find(Boolean);
}
