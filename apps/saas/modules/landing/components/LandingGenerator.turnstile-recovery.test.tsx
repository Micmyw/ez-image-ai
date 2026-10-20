import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
	process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY = "test-turnstile-site-key";
	return {
		cursor: 0,
		states: [] as unknown[],
		initialized: [] as boolean[],
		refCursor: 0,
		refs: [] as Array<{ current: unknown }>,
		capabilityEffect: undefined as (() => unknown) | undefined,
		queryClient: { fetchQuery: vi.fn(async () => ({ products: [] })) },
		getCapability: vi.fn(),
		upload: vi.fn(),
		turnstile: vi.fn(() => null),
		modelSelector: vi.fn(() => null),
	};
});

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		// Run the availability effect explicitly; unrelated browser observers stay outside this harness.
		useEffect: (effect: () => unknown, dependencies?: unknown[]) => {
			if (dependencies?.includes(harness.queryClient)) harness.capabilityEffect = effect;
		},
		useMemo: <T,>(factory: () => T) => factory(),
		useRef: <T,>(initial: T) => {
			const index = harness.refCursor++;
			harness.refs[index] ??= { current: initial };
			return harness.refs[index] as { current: T };
		},
		useState: <T,>(initial: T | (() => T)) => {
			const index = harness.cursor++;
			if (!harness.initialized[index]) {
				harness.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
				harness.initialized[index] = true;
			}
			return [
				harness.states[index] as T,
				(next: T | ((current: T) => T)) => {
					harness.states[index] =
						typeof next === "function"
							? (next as (current: T) => T)(harness.states[index] as T)
							: next;
				},
			] as const;
		},
	};
});
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => harness.queryClient }));
vi.mock("@repo/ui/components/turnstile", () => ({ Turnstile: harness.turnstile }));
vi.mock("@repo/ui/components/alert", () => ({ Alert: () => null, AlertDescription: () => null }));
vi.mock("@repo/ui/components/button", () => ({ Button: () => null }));
vi.mock("@repo/ui/components/textarea", () => ({ Textarea: () => null }));
vi.mock("@repo/utils/lib/growth-analytics-browser", () => ({ trackBrowserGrowthEvent: vi.fn() }));
vi.mock("@media/components/editor/ComposerHeader", () => ({ ComposerHeader: () => null }));
vi.mock("@media/components/editor/PromptIdeas", () => ({ PromptIdeas: () => null }));
vi.mock("@media/components/ImageModelSelector", () => ({
	ImageModelSelector: harness.modelSelector,
}));
vi.mock("@media/components/ImageOutputSettings", () => ({ ImageOutputSettings: () => null }));
vi.mock("@media/hooks/use-model-navigation", () => ({
	useRequestedImageModel: () => "image-nano-banana-2-lite",
	useModelNavigation: () => ({ unavailable: false }),
	replaceImageModelInUrl: vi.fn(),
}));
vi.mock("@media/lib/public-catalog-query", () => ({ publicCatalogQueryOptions: {} }));
vi.mock("@media/lib/tool-prompt-context", () => ({
	useToolPrompt: () => null,
	useToolPromptBinding: vi.fn(),
}));
vi.mock("../../effects/lib/editor-context", () => ({
	useEffectEditor: () => null,
	useEffectEditorBinding: vi.fn(),
}));
vi.mock("../../media/lib/generation-mode-context", () => ({
	useGenerationMode: () => null,
	useGeneratorSignInDraft: vi.fn(),
}));
vi.mock("../lib/use-showcase-prompt", () => ({
	useShowcasePrompt: () => "Preserve this guest edit",
}));
vi.mock("../lib/guest-draft-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/guest-draft-client")>()),
	getGuestCapability: harness.getCapability,
	uploadGuestDraft: harness.upload,
}));

import { readEditorUpgradeDraft } from "@payments/lib/editor-upgrade";
import { Turnstile } from "@repo/ui/components/turnstile";

import { LandingGenerator } from "./LandingGenerator";

const source = new File(["source"], "private-source.png", { type: "image/png" });
const product = {
	key: "image-nano-banana-2-lite",
	label: "Nano Banana 2 Lite",
	description: "Guest edit",
	credits: "5",
	accessHint: "guest-trial",
	aspectRatios: ["auto"],
	skuMatrix: {
		defaultSkuKey: "nano-banana-2-lite-1k",
		dimensions: [],
		cells: [
			{
				skuKey: "nano-banana-2-lite-1k",
				label: "1K",
				parameterValues: { resolution: "1k" },
				credits: 5,
				aspectRatios: ["auto"],
				controls: [],
			},
		],
	},
};

describe("LandingGenerator verification feedback", () => {
	afterEach(() => vi.unstubAllGlobals());
	beforeEach(() => {
		vi.clearAllMocks();
		harness.queryClient.fetchQuery.mockResolvedValue({ products: [] });
		harness.cursor = 0;
		harness.states = [];
		harness.initialized = [];
		harness.refCursor = 0;
		harness.refs = [];
		harness.capabilityEffect = undefined;
		harness.getCapability.mockResolvedValue({
			version: "capability-v1",
			enabled: true,
			reason: null,
			upload: { maximumBytes: 10 * 1024 * 1024, mimeTypes: ["image/png"] },
			products: [product],
			queueEstimate: { kind: "capacity" },
		});
	});

	it("makes reference editing ready while the unrelated text catalog is still pending", async () => {
		harness.queryClient.fetchQuery.mockReturnValueOnce(new Promise(() => {}));
		renderWorkspace();
		harness.capabilityEffect?.();
		await vi.waitFor(() =>
			expect(findElement(renderWorkspace(), "output")?.props["data-stage"]).toBe("ready"),
		);
	});

	it("makes text editing ready while the unrelated upload capability is still pending", async () => {
		harness.getCapability.mockReturnValueOnce(new Promise(() => {}));
		harness.queryClient.fetchQuery.mockResolvedValueOnce({
			products: [{ ...product, inputKinds: ["text-to-image"] }],
		} as never);
		renderWorkspace(false);
		harness.capabilityEffect?.();
		await vi.waitFor(() =>
			expect(findElement(renderWorkspace(false), "output")?.props["data-stage"]).toBe("ready"),
		);
	});

	it("does not overwrite an active handoff when a late upload capability arrives", async () => {
		let resolveCapability!: (value: unknown) => void;
		harness.getCapability.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveCapability = resolve;
			}),
		);
		harness.queryClient.fetchQuery.mockResolvedValueOnce({
			products: [{ ...product, inputKinds: ["text-to-image"] }],
		} as never);
		renderWorkspace(false);
		harness.capabilityEffect?.();
		await vi.waitFor(() =>
			expect(findElement(renderWorkspace(false), "output")?.props["data-stage"]).toBe("ready"),
		);
		// Model/SKU selection is made by the same control used by the real form.
		callback<(key: string) => void>(
			renderWorkspace(false),
			harness.modelSelector,
			"onChange",
		)(product.key);
		vi.stubGlobal("window", {
			sessionStorage: { setItem: vi.fn(), getItem: () => null, removeItem: vi.fn() },
			location: { assign: vi.fn() },
		});
		callback<(event: { preventDefault: () => void }) => void>(
			renderWorkspace(false),
			"form",
			"onSubmit",
		)({ preventDefault: vi.fn() });
		expect(findElement(renderWorkspace(false), "output")?.props["data-stage"]).toBe("handoff");
		resolveCapability({
			enabled: true,
			products: [product],
			upload: { maximumBytes: 10 * 1024 * 1024, mimeTypes: ["image/png"] },
		});
		await Promise.resolve();
		expect(findElement(renderWorkspace(false), "output")?.props["data-stage"]).toBe("handoff");
	});

	it.each([
		["GUEST_UPLOAD_CONTENT_REJECTED", "contentRejected"],
		["GUEST_UPLOAD_REVIEW_REQUIRED", "reviewRequired"],
		["GUEST_UPLOAD_SAFETY_UNAVAILABLE", "safetyUnavailable"],
		["GUEST_UPLOAD_COMPLETION_TIMEOUT", "reviewPending"],
		["GUEST_UPLOAD_SESSION_EXPIRED", "referenceExpired"],
	])("shows %s without calling it an upload or content failure", async (failure, key) => {
		let tree = await readyWorkspace();
		callback<(token: string) => void>(tree, Turnstile, "onToken")("token-one");
		tree = renderWorkspace();
		harness.upload.mockRejectedValueOnce(new Error(failure));
		callback<(event: { preventDefault: () => void }) => void>(
			tree,
			"form",
			"onSubmit",
		)({ preventDefault: vi.fn() });
		await vi.waitFor(() => expect(visibleText(renderWorkspace())).toContain(`errors.${key}`));
		expect(visibleText(renderWorkspace())).not.toContain("errors.upload");
	});
	it("retains the acknowledged upload checkpoint for the next explicit retry", async () => {
		let tree = await readyWorkspace();
		callback<(token: string) => void>(tree, Turnstile, "onToken")("token-one");
		tree = renderWorkspace();
		const checkpoint = {
			requestFingerprint: "opaque-fingerprint",
			intent: { sessionId: "same-session", assetId: "same-asset" },
			uploaded: true,
		};
		harness.upload.mockImplementationOnce(
			async (input: { onCheckpoint: (value: unknown) => void }) => {
				input.onCheckpoint(checkpoint);
				throw new Error("GUEST_UPLOAD_COMPLETION_FAILED");
			},
		);
		callback<(event: { preventDefault: () => void }) => void>(
			tree,
			"form",
			"onSubmit",
		)({ preventDefault: vi.fn() });
		await vi.waitFor(() =>
			expect(visibleText(renderWorkspace())).toContain("errors.reviewUnknown"),
		);
		callback<(token: string) => void>(renderWorkspace(), Turnstile, "onToken")("token-two");
		tree = renderWorkspace();
		harness.upload.mockRejectedValueOnce(new Error("GUEST_UPLOAD_COMPLETION_TIMEOUT"));
		callback<(event: { preventDefault: () => void }) => void>(
			tree,
			"form",
			"onSubmit",
		)({ preventDefault: vi.fn() });
		await vi.waitFor(() => expect(harness.upload).toHaveBeenCalledTimes(2));
		expect(harness.upload.mock.calls[1]![0]).toMatchObject({ checkpoint });
	});

	it.each(["GUEST_UPLOAD_RATE_LIMITED", "GUEST_UPLOAD_INTENT_FAILED"])(
		"keeps %s visible when verification supplies the next token",
		async (failure) => {
			let tree = await readyWorkspace();
			callback<(token: string) => void>(tree, Turnstile, "onToken")("token-one");
			tree = renderWorkspace();
			harness.upload.mockRejectedValueOnce(new Error(failure));
			callback<(event: { preventDefault: () => void }) => void>(
				tree,
				"form",
				"onSubmit",
			)({
				preventDefault: vi.fn(),
			});
			const errorKey =
				failure === "GUEST_UPLOAD_RATE_LIMITED" ? "errors.rateLimit" : "errors.upload";
			await vi.waitFor(() => expect(visibleText(renderWorkspace())).toContain(errorKey));
			expect(visibleText(renderWorkspace()).includes("actions.signInBonus")).toBe(
				failure === "GUEST_UPLOAD_RATE_LIMITED",
			);

			tree = renderWorkspace();
			callback<(token: string) => void>(tree, Turnstile, "onToken")("token-two");
			expect(visibleText(renderWorkspace())).toContain(errorKey);
			expect(harness.upload).toHaveBeenCalledOnce();
			expect(harness.upload).toHaveBeenCalledWith(
				expect.objectContaining({
					file: source,
					prompt: "Preserve this guest edit",
					productKey: product.key,
					turnstileToken: "token-one",
				}),
			);
		},
	);

	it("keeps the upload limit explanation when the refreshed widget fails", async () => {
		let tree = await readyWorkspace();
		callback<(token: string) => void>(tree, Turnstile, "onToken")("token-one");
		tree = renderWorkspace();
		harness.upload.mockRejectedValueOnce(new Error("GUEST_UPLOAD_RATE_LIMITED"));
		callback<(event: { preventDefault: () => void }) => void>(
			tree,
			"form",
			"onSubmit",
		)({
			preventDefault: vi.fn(),
		});
		await vi.waitFor(() => expect(visibleText(renderWorkspace())).toContain("errors.rateLimit"));
		callback<() => void>(renderWorkspace(), Turnstile, "onError")();
		tree = renderWorkspace();
		expect(visibleText(tree)).toContain("errors.rateLimit");
		callback<(token: string) => void>(tree, Turnstile, "onToken")("token-two");
		expect(visibleText(renderWorkspace())).toContain("errors.rateLimit");
	});
	it("saves the guest prompt and model before the upload-limit sign-in action redirects", async () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		};
		const assign = vi.fn();
		vi.stubGlobal("window", { location: { origin: "https://app.ezpic.test", assign } });
		vi.stubGlobal("sessionStorage", storage);
		let tree = await readyWorkspace();
		callback<(token: string) => void>(tree, Turnstile, "onToken")("token-one");
		tree = renderWorkspace();
		harness.upload.mockRejectedValueOnce(new Error("GUEST_UPLOAD_RATE_LIMITED"));
		callback<(event: { preventDefault: () => void }) => void>(
			tree,
			"form",
			"onSubmit",
		)({ preventDefault: vi.fn() });
		await vi.waitFor(() => expect(visibleText(renderWorkspace())).toContain("actions.signInBonus"));
		const action = findTextElement(renderWorkspace(), "actions.signInBonus");
		if (!action) throw new Error("Sign-in action was not rendered");
		expect(action.props.onClick).toBeTypeOf("function");
		(action.props.onClick as () => void)();
		await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce());
		const destination = new URL(assign.mock.calls[0]![0], "https://app.ezpic.test");
		expect(destination.pathname).toBe("/login");
		expect(destination.searchParams.get("redirectTo")).toBe("/create?resume=text");
		expect(readEditorUpgradeDraft(storage)).toMatchObject({
			draft: {
				productKey: product.key,
				input: {
					kind: "image-to-image",
					prompt: "Preserve this guest edit",
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "auto",
				},
			},
			sourceReady: false,
		});
		expect(harness.upload).toHaveBeenCalledOnce();
	});

	it("clears a verification error when a fresh token arrives", async () => {
		let tree = await readyWorkspace();
		callback<() => void>(tree, Turnstile, "onError")();
		tree = renderWorkspace();
		expect(visibleText(tree)).toContain("errors.turnstile");
		callback<(token: string) => void>(tree, Turnstile, "onToken")("fresh-token");
		expect(visibleText(renderWorkspace())).not.toContain("errors.turnstile");
	});
});

async function readyWorkspace() {
	void renderWorkspace();
	expect(harness.capabilityEffect).toBeTypeOf("function");
	await harness.capabilityEffect?.();
	await vi.waitFor(() =>
		expect(findElement(renderWorkspace(), "output")?.props["data-stage"]).toBe("ready"),
	);
	const tree = renderWorkspace();
	callback<(key: string) => void>(tree, harness.modelSelector, "onChange")(product.key);
	return renderWorkspace();
}

function renderWorkspace(withSource = true): ReactElement {
	harness.cursor = 0;
	harness.refCursor = 0;
	const wrapper = LandingGenerator({ initialFile: withSource ? source : undefined });
	const Workspace = wrapper.type as (props: typeof wrapper.props) => ReactElement;
	return Workspace(wrapper.props);
}

function findElement(
	node: ReactNode,
	type: unknown,
): ReactElement<Record<string, unknown>> | undefined {
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (node.type === type) return node;
	return React.Children.toArray(node.props.children as ReactNode)
		.map((child) => findElement(child, type))
		.find(Boolean);
}

function callback<T extends (...arguments_: never[]) => unknown>(
	tree: ReactNode,
	type: unknown,
	name: string,
): T {
	const handler = findElement(tree, type)?.props[name];
	expect(handler).toBeTypeOf("function");
	return handler as T;
}

function visibleText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (!isValidElement<Record<string, unknown>>(node)) return "";
	return React.Children.toArray(node.props.children as ReactNode)
		.map(visibleText)
		.join(" ");
}

function findTextElement(
	node: ReactNode,
	text: string,
): ReactElement<Record<string, unknown>> | undefined {
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (node.props.children === text) return node;
	return React.Children.toArray(node.props.children as ReactNode)
		.map((child) => findTextElement(child, text))
		.find(Boolean);
}
