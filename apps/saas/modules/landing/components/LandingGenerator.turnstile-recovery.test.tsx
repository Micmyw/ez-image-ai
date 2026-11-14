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
		preparationEffect: undefined as (() => unknown) | undefined,
		authRestoreEffect: undefined as (() => unknown) | undefined,
		initialFileEffect: undefined as (() => unknown) | undefined,
		queryClient: { fetchQuery: vi.fn() },
		getCapability: vi.fn(),
		getCatalog: vi.fn(),
		prepare: vi.fn(),
		saveAuthDraft: vi.fn(),
		readAuthDraft: vi.fn(),
		upload: vi.fn(),
		turnstile: vi.fn(() => null),
		modelSelector: vi.fn(() => null),
		effectEditor: null as
			| import("../../effects/lib/editor-context").EffectEditorContextValue
			| null,
		handoff: vi.fn(),
	};
});

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		// Run the availability effect explicitly; unrelated browser observers stay outside this harness.
		useEffect: (effect: () => unknown, dependencies?: unknown[]) => {
			if (dependencies?.includes(harness.queryClient)) harness.capabilityEffect = effect;
			const first = dependencies?.[0];
			if (first instanceof File && dependencies?.length === 2) harness.initialFileEffect = effect;
			if (first && typeof first === "object" && "ensure" in first && "read" in first)
				harness.preparationEffect = effect;
			if (
				dependencies?.length === 3 &&
				typeof first === "boolean" &&
				typeof dependencies[1] === "boolean"
			)
				harness.authRestoreEffect = effect;
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
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQueryClient: () => harness.queryClient,
}));
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
vi.mock("@media/components/ImagePurposeShortcuts", () => ({ ImagePurposeShortcuts: () => null }));
vi.mock("@auth/lib/auth-draft-storage", () => ({
	saveAuthDraft: harness.saveAuthDraft,
	readAuthDraft: harness.readAuthDraft,
	applyAuthDraftToDestination: (destination: URL, id: string) =>
		destination.searchParams.set("authDraft", id),
}));
vi.mock("@media/components/ImageOutputSettings", () => ({ ImageOutputSettings: () => null }));
vi.mock("@media/hooks/use-model-navigation", () => ({
	useRequestedImageModel: () => "image-nano-banana-2-lite",
	useRequestedImageOutputFormat: () => undefined,
	useModelNavigation: () => ({ unavailable: false }),
	replaceImageModelInUrl: vi.fn(),
}));
vi.mock("@media/lib/public-catalog-query", () => ({ publicCatalogQueryOptions: {} }));
vi.mock("@media/lib/tool-prompt-context", () => ({
	useToolPrompt: () => null,
	useToolPromptBinding: vi.fn(),
}));
vi.mock("../../effects/lib/editor-context", () => ({
	useEffectEditor: () => harness.effectEditor,
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
	prepareGuestDraftUpload: harness.prepare,
	uploadGuestDraft: harness.upload,
	submitGuestDraftHandoff: harness.handoff,
}));

import { PaidTemplateDialog } from "@payments/components/PaidTemplateDialog";
import { readPaidTemplatePurchase } from "@payments/lib/paid-template-purchase";
import { Textarea } from "@repo/ui/components/textarea";
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
		harness.getCatalog.mockResolvedValue({ products: [] });
		harness.queryClient.fetchQuery.mockImplementation(
			(options?: { queryKey?: readonly unknown[] }) =>
				options?.queryKey?.[0] === "guest-capability"
					? harness.getCapability()
					: harness.getCatalog(),
		);
		harness.saveAuthDraft.mockResolvedValue({
			id: "10000000-0000-4000-8000-000000000001",
			returnPath: "/create",
		});
		harness.readAuthDraft.mockResolvedValue(null);
		harness.prepare.mockImplementation(
			async (input: import("../lib/guest-draft-client").GuestUploadPreparationInput) => {
				const checkpoint = input.checkpoint ?? {
					fileFingerprint: "same-file",
					preparedFile: input.file,
					sha256: "a".repeat(64),
					requestId: "10000000-0000-4000-8000-000000000002",
					capabilityVersion: input.capabilityVersion,
					intentProductKey: input.productKey,
					intent: {
						sessionId: "same-session",
						assetId: "same-asset",
						uploadUrl: "https://storage.test/upload",
						completionToken: "c".repeat(43),
						expiresAt: "2035-01-01T00:00:00.000Z",
					},
					uploaded: true,
					sealed: true,
				};
				input.onCheckpoint?.(checkpoint);
				return checkpoint;
			},
		);
		harness.cursor = 0;
		harness.states = [];
		harness.initialized = [];
		harness.refCursor = 0;
		harness.refs = [];
		harness.capabilityEffect = undefined;
		harness.preparationEffect = undefined;
		harness.authRestoreEffect = undefined;
		harness.initialFileEffect = undefined;
		harness.effectEditor = null;
		harness.getCapability.mockResolvedValue({
			version: "capability-v1",
			enabled: true,
			reason: null,
			upload: { maximumBytes: 10 * 1024 * 1024, mimeTypes: ["image/png"] },
			products: [product],
			queueEstimate: { kind: "capacity" },
		});
	});
	it("prepares an empty-prompt reference before Generate and shares it with the changed prompt", async () => {
		vi.stubGlobal("document", {});
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
		let tree = await readyWorkspace();
		callback<(event: { target: { value: string } }) => void>(
			tree,
			Textarea,
			"onChange",
		)({ target: { value: "" } });
		callback<(token: string) => void>(tree, Turnstile, "onToken")("early-token");
		tree = renderWorkspace();
		harness.preparationEffect?.();
		await vi.waitFor(() => expect(harness.prepare).toHaveBeenCalledOnce());
		expect(harness.prepare.mock.calls[0]?.[0]).not.toHaveProperty("prompt");
		expect(harness.upload).not.toHaveBeenCalled();
		expect(visibleText(renderWorkspace())).not.toContain("states.verifying");
		callback<(event: { target: { value: string } }) => void>(
			renderWorkspace(),
			Textarea,
			"onChange",
		)({ target: { value: "New prompt after upload" } });
		tree = renderWorkspace();
		harness.preparationEffect?.();
		expect(harness.prepare).toHaveBeenCalledOnce();
		harness.upload.mockResolvedValueOnce({
			accessHint: "guest-trial",
			action: "/draft/continue",
			claimToken: "c".repeat(43),
		});
		callback<(event: { preventDefault: () => void }) => void>(
			tree,
			"form",
			"onSubmit",
		)({ preventDefault() {} });
		await vi.waitFor(() => expect(harness.handoff).toHaveBeenCalledOnce());
		expect(harness.upload).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "New prompt after upload",
				checkpoint: expect.objectContaining({
					intent: expect.objectContaining({ sessionId: "same-session" }),
				}),
			}),
		);
	});
	it("restores the original file and parameters when returning from login", async () => {
		vi.stubGlobal("window", {
			location: { href: "https://app.ezpic.test/?authDraft=10000000-0000-4000-8000-000000000001" },
		});
		harness.readAuthDraft.mockResolvedValue({
			file: source,
			values: {
				productKey: product.key,
				skuKey: "nano-banana-2-lite-1k",
				prompt: "Recovered original edit",
				sourceAssetId: "",
				aspectRatio: "auto",
			},
		});
		renderWorkspace(false);
		harness.capabilityEffect?.();
		renderWorkspace(false);
		harness.authRestoreEffect?.();
		await vi.waitFor(() =>
			expect(findElement(renderWorkspace(false), Textarea)?.props.value).toBe(
				"Recovered original edit",
			),
		);
		callback<(token: string) => void>(
			renderWorkspace(false),
			Turnstile,
			"onToken",
		)("restored-token");
		await vi.waitFor(() => {
			renderWorkspace(false);
			harness.preparationEffect?.();
			expect(harness.prepare).toHaveBeenCalledWith(
				expect.objectContaining({ file: source, productKey: product.key }),
			);
		});
		expect(harness.upload).not.toHaveBeenCalled();
	});
	it("does not overwrite a new edit with a late authentication draft", async () => {
		vi.stubGlobal("window", {
			location: { href: "https://app.ezpic.test/?authDraft=10000000-0000-4000-8000-000000000001" },
		});
		let resolve!: (value: unknown) => void;
		harness.readAuthDraft.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		renderWorkspace(false);
		harness.authRestoreEffect?.();
		await vi.waitFor(() => expect(harness.readAuthDraft).toHaveBeenCalledOnce());
		callback<(event: { target: { value: string } }) => void>(
			renderWorkspace(false),
			Textarea,
			"onChange",
		)({ target: { value: "My newer edit" } });
		resolve({
			file: source,
			values: {
				productKey: product.key,
				skuKey: "nano-banana-2-lite-1k",
				prompt: "Older saved edit",
				sourceAssetId: "",
				aspectRatio: "auto",
			},
		});
		await Promise.resolve();
		expect(findElement(renderWorkspace(false), Textarea)?.props.value).toBe("My newer edit");
	});
	it("restores after StrictMode replays an unfinished authentication effect", async () => {
		vi.stubGlobal("window", {
			location: { href: "https://app.ezpic.test/?authDraft=10000000-0000-4000-8000-000000000001" },
		});
		let resolveOld!: (value: unknown) => void;
		harness.readAuthDraft
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
			)
			.mockResolvedValueOnce({
				file: null,
				values: {
					productKey: product.key,
					skuKey: "nano-banana-2-lite-1k",
					prompt: "Restored after effect replay",
					sourceAssetId: "",
					aspectRatio: "auto",
				},
			});
		renderWorkspace(false);
		const cleanup = harness.authRestoreEffect?.();
		await vi.waitFor(() => expect(harness.readAuthDraft).toHaveBeenCalledOnce());
		if (typeof cleanup === "function") cleanup();
		renderWorkspace(false);
		harness.authRestoreEffect?.();
		await vi.waitFor(() =>
			expect(findElement(renderWorkspace(false), Textarea)?.props.value).toBe(
				"Restored after effect replay",
			),
		);
		resolveOld(null);
		await Promise.resolve();
		expect(findElement(renderWorkspace(false), Textarea)?.props.value).toBe(
			"Restored after effect replay",
		);
	});
	it("shows the paid offer after Generate and creates a handoff only after a purchase choice", async () => {
		const premium = setupPaidTemplate();
		let tree = await readyWorkspace();
		callback<(token: string) => void>(tree, Turnstile, "onToken")("paid-token");
		tree = renderWorkspace();
		expect(findElement(tree, harness.modelSelector)?.props.disabled).toBe(true);
		callback<(event: { preventDefault: () => void }) => void>(
			tree,
			"form",
			"onSubmit",
		)({ preventDefault() {} });
		expect(findElement(renderWorkspace(), PaidTemplateDialog)?.props.open).toBe(true);
		expect(harness.upload).not.toHaveBeenCalled();
		const handoff = { accessHint: "paid-account", action: "/auth/handoff", claimToken: "claimed" };
		harness.upload.mockResolvedValueOnce(handoff);
		callback<() => void>(renderWorkspace(), PaidTemplateDialog, "onImagePass")();
		await vi.waitFor(() => expect(harness.handoff).toHaveBeenCalledOnce());
		expect(harness.upload).toHaveBeenCalledWith(
			expect.objectContaining({
				file: source,
				productKey: premium.key,
				prompt: "Preserve this guest edit",
				skuKey: "nano-banana-2-1k",
			}),
		);
		expect(
			readPaidTemplatePurchase(window.sessionStorage, {
				effectId: "sheru-bhai-ai-photo",
				presetId: "with-sheru",
			}),
		).toBe("image-pass");
		expect(harness.handoff).toHaveBeenCalledWith(
			handoff,
			document,
			"/blog/sheru-bhai-ai-photo?preset=with-sheru",
		);
	});
	it("never hands a paid template to sponsored guest generation", async () => {
		setupPaidTemplate();
		let tree = await readyWorkspace();
		callback<(token: string) => void>(tree, Turnstile, "onToken")("paid-token");
		tree = renderWorkspace();
		harness.upload.mockResolvedValueOnce({
			accessHint: "guest-trial",
			action: "/auth/handoff",
			claimToken: "wrong",
		});
		callback<() => void>(tree, PaidTemplateDialog, "onPlans")();
		await vi.waitFor(() => expect(visibleText(renderWorkspace())).toContain("errors.upload"));
		expect(harness.handoff).not.toHaveBeenCalled();
		expect(
			readPaidTemplatePurchase(window.sessionStorage, {
				effectId: "sheru-bhai-ai-photo",
				presetId: "with-sheru",
			}),
		).toBeNull();
	});

	it("makes reference editing ready while the unrelated text catalog is still pending", async () => {
		harness.getCatalog.mockReturnValueOnce(new Promise(() => {}));
		renderWorkspace();
		harness.initialFileEffect?.();
		harness.capabilityEffect?.();
		await vi.waitFor(() =>
			expect(findElement(renderWorkspace(), "output")?.props["data-stage"]).toBe("ready"),
		);
	});

	it("makes text editing ready while the unrelated upload capability is still pending", async () => {
		harness.getCapability.mockReturnValueOnce(new Promise(() => {}));
		harness.getCatalog.mockResolvedValueOnce({
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
		harness.getCatalog.mockResolvedValueOnce({
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
			location: {
				assign: vi.fn(),
				origin: "https://app.ezpic.test",
				href: "https://app.ezpic.test/",
				pathname: "/",
				search: "",
			},
			history: { state: null, replaceState: vi.fn() },
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
			harness.prepare.mockRejectedValueOnce(new Error(failure));
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
			expect(harness.upload).not.toHaveBeenCalled();
			expect(harness.prepare).toHaveBeenCalledWith(
				expect.objectContaining({
					file: source,
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
		harness.prepare.mockRejectedValueOnce(new Error("GUEST_UPLOAD_RATE_LIMITED"));
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
		vi.stubGlobal("window", {
			location: {
				origin: "https://app.ezpic.test",
				href: "https://app.ezpic.test/",
				pathname: "/",
				search: "",
				assign,
			},
			history: { state: null, replaceState: vi.fn() },
		});
		vi.stubGlobal("sessionStorage", storage);
		let tree = await readyWorkspace();
		callback<(token: string) => void>(tree, Turnstile, "onToken")("token-one");
		tree = renderWorkspace();
		harness.prepare.mockRejectedValueOnce(new Error("GUEST_UPLOAD_RATE_LIMITED"));
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
		expect(destination.searchParams.get("redirectTo")).toContain(
			"authDraft=10000000-0000-4000-8000-000000000001",
		);
		expect(harness.saveAuthDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				file: source,
				values: {
					productKey: product.key,
					prompt: "Preserve this guest edit",
					sourceAssetId: "",
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "auto",
				},
			}),
		);
		expect(harness.upload).not.toHaveBeenCalled();
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
	harness.initialFileEffect?.();
	expect(harness.capabilityEffect).toBeTypeOf("function");
	await harness.capabilityEffect?.();
	await vi.waitFor(() =>
		expect(findElement(renderWorkspace(), harness.modelSelector)?.props.products).toHaveLength(1),
	);
	const tree = renderWorkspace();
	callback<(key: string) => void>(tree, harness.modelSelector, "onChange")(product.key);
	return renderWorkspace();
}

function setupPaidTemplate() {
	const premium = {
		...product,
		key: "image-nano-banana-2",
		accessHint: "paid-account",
		aspectRatios: ["4:5"],
		skuMatrix: {
			...product.skuMatrix,
			defaultSkuKey: "nano-banana-2-1k",
			cells: [{ ...product.skuMatrix.cells[0], skuKey: "nano-banana-2-1k", aspectRatios: ["4:5"] }],
		},
	};
	harness.effectEditor = {
		effect: { id: "sheru-bhai-ai-photo", generationAccess: "paid" },
		selectedPreset: {
			id: "with-sheru",
			productKey: "image-nano-banana-2",
			parameters: { skuKey: "nano-banana-2-1k", aspectRatio: "4:5" },
			inputRequirement: "required",
		},
		getReturnPath: () => "/blog/sheru-bhai-ai-photo?preset=with-sheru",
		getAnalyticsContext: () => undefined,
	} as unknown as NonNullable<typeof harness.effectEditor>;
	harness.getCapability.mockResolvedValue({
		version: "capability-v1",
		enabled: true,
		reason: null,
		upload: { maximumBytes: 10 * 1024 * 1024, mimeTypes: ["image/png"] },
		products: [product, premium],
		queueEstimate: { kind: "capacity" },
	});
	const entries = new Map<string, string>();
	vi.stubGlobal("window", {
		sessionStorage: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
			removeItem: (key: string) => entries.delete(key),
		},
		requestAnimationFrame: (callback: () => void) => callback(),
	});
	vi.stubGlobal("document", {});
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
	return premium;
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
