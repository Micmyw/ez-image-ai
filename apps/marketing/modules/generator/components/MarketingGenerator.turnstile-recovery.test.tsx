import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
	process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY = "turnstile-site-key";
	return {
		authHandoffStarted: vi.fn(() => Promise.resolve("sent")),
		cursor: 0,
		initialized: [] as boolean[],
		marketingDraftCreated: vi.fn(() => Promise.resolve("sent")),
		refs: [] as Array<{ current: unknown }>,
		refCursor: 0,
		states: [] as unknown[],
		submitMarketingDraftHandoff: vi.fn(),
		turnstile: vi.fn(() => null),
		uploadGuestDraft: vi.fn(),
	};
});

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useEffect: vi.fn(),
		useRef: <T,>(initial: T) => {
			const index = testState.refCursor++;
			testState.refs[index] ??= { current: initial };
			return testState.refs[index] as { current: T };
		},
		useState: <T,>(initial: T | (() => T)) => {
			const index = testState.cursor++;
			if (!testState.initialized[index]) {
				testState.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
				testState.initialized[index] = true;
			}
			const setState = (next: T | ((current: T) => T)) => {
				const current = testState.states[index] as T;
				testState.states[index] =
					typeof next === "function" ? (next as (current: T) => T)(current) : next;
			};
			return [testState.states[index] as T, setState] as const;
		},
	};
});
vi.mock("@analytics", () => ({
	marketingGrowthFunnel: {
		authHandoffStarted: testState.authHandoffStarted,
		marketingDraftCreated: testState.marketingDraftCreated,
		sourceUploadCompleted: vi.fn(() => Promise.resolve("sent")),
		sourceUploadStarted: vi.fn(() => Promise.resolve("sent")),
	},
}));
vi.mock("@config", () => ({ config: { saasUrl: "https://app.configured.test" } }));
vi.mock("@i18n/routing", () => ({ LocaleLink: () => null }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@repo/ui/components/alert", () => ({ Alert: () => null, AlertDescription: () => null }));
vi.mock("@repo/ui/components/button", () => ({ Button: vi.fn(() => null) }));
vi.mock("@repo/ui/components/textarea", () => ({ Textarea: vi.fn(() => null) }));
vi.mock("@repo/ui/components/turnstile", () => ({ Turnstile: testState.turnstile }));
vi.mock("../lib/guest-upload-client", () => ({ uploadGuestDraft: testState.uploadGuestDraft }));
vi.mock("../lib/draft-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/draft-client")>();
	return { ...actual, submitMarketingDraftHandoff: testState.submitMarketingDraftHandoff };
});

import { Button } from "@repo/ui/components/button";
import { Turnstile } from "@repo/ui/components/turnstile";

import { ImageDropzone } from "../../image-editor/components/ImageDropzone";
import { MarketingGenerator } from "./MarketingGenerator";

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

describe("MarketingGenerator Turnstile recovery", () => {
	beforeEach(() => {
		testState.cursor = 0;
		testState.initialized = [];
		testState.refs = [];
		testState.refCursor = 0;
		testState.states = [];
		vi.clearAllMocks();
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:source");
		testState.uploadGuestDraft
			.mockRejectedValueOnce(new Error("UPLOAD_FAILED"))
			.mockResolvedValueOnce({
				action: "https://app.configured.test/draft/continue",
				claimToken: "a".repeat(43),
			});
	});

	it("remounts a consumed challenge and accepts a fresh token after upload failure", async () => {
		let tree = renderGenerator();
		const file = { name: "private.png", size: 1024, type: "image/png" } as File;
		callbackProp<(file: File) => void>(
			findElement(tree, (element) => element.type === ImageDropzone),
			"onFile",
		)?.(file);
		callbackProp<(event: { target: { value: string } }) => void>(
			findElement(tree, (element) => element.props.id === "marketing-prompt"),
			"onChange",
		)?.({ target: { value: "Keep the subject and replace the background" } });
		tree = renderGenerator();
		const firstChallenge = findElement(tree, (element) => element.type === Turnstile);
		callbackProp<(token: string) => void>(firstChallenge, "onToken")?.("turnstile-token-1");
		tree = renderGenerator();

		callbackProp<(event: { preventDefault: () => void }) => void>(
			findElement(tree, (element) => element.type === "form"),
			"onSubmit",
		)?.({ preventDefault: vi.fn() });
		await vi.waitFor(() => expect(testState.uploadGuestDraft).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		tree = renderGenerator();
		const retriedChallenge = findElement(tree, (element) => element.type === Turnstile);

		expect(retriedChallenge?.props.resetKey).toBe(1);
		callbackProp<(token: string) => void>(retriedChallenge, "onToken")?.("turnstile-token-2");
		tree = renderGenerator();
		expect(findElement(tree, (element) => element.type === Button)?.props.disabled).toBe(false);
		callbackProp<(event: { preventDefault: () => void }) => void>(
			findElement(tree, (element) => element.type === "form"),
			"onSubmit",
		)?.({ preventDefault: vi.fn() });
		await vi.waitFor(() => expect(testState.uploadGuestDraft).toHaveBeenCalledTimes(2));

		expect(testState.uploadGuestDraft.mock.calls.map(([input]) => input.turnstileToken)).toEqual([
			"turnstile-token-1",
			"turnstile-token-2",
		]);
	});
});

function renderGenerator() {
	testState.cursor = 0;
	testState.refCursor = 0;
	return MarketingGenerator({ capability });
}

function findElement(
	node: ReactNode,
	predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (predicate(node)) return node;
	const children = node.props.children as ReactNode;
	return React.Children.toArray(children)
		.map((child) => findElement(child, predicate))
		.find(Boolean);
}

function callbackProp<T extends (...arguments_: never[]) => unknown>(
	element: ReactElement<Record<string, unknown>> | undefined,
	name: string,
): T | undefined {
	const value = element?.props[name];
	return typeof value === "function" ? (value as T) : undefined;
}
