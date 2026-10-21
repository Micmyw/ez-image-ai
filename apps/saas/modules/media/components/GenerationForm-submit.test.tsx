import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	loaded: true,
	passAvailable: 3 as number | undefined,
	passReserved: 0,
	passFailed: false,
	creditFailed: false,
	spendableCredits: "100",
	generationPending: false,
	cursor: 0,
	slots: [] as {
		current?: unknown;
		value?: unknown;
		deps?: unknown[];
		cleanup?: (() => void) | void;
	}[],
	values: {
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		prompt: "A paper landscape",
		aspectRatio: "auto",
		sourceAssetId: "",
	},
	mutateAsync: vi.fn(),
	beginNewAction: vi.fn(),
	visibility: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useRef: (value: unknown) => (state.slots[state.cursor++] ??= { current: value }),
	useState: (value: unknown) => {
		const slot = (state.slots[state.cursor++] ??= { value });
		return [
			slot.value,
			(next: unknown) => {
				slot.value = next;
			},
		];
	},
	useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
		const index = state.cursor++,
			previous = state.slots[index];
		if (previous?.deps && deps.every((value, index) => value === previous.deps![index])) return;
		previous?.cleanup?.();
		state.slots[index] = { deps, cleanup: effect() };
	},
	useMemo: (fn: () => unknown) => fn(),
	useCallback: (fn: unknown) => fn,
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ loaded: state.loaded, user: { id: state.ownerId } }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@shared/hooks/generation-analytics", () => ({
	useGenerationAnalytics: vi.fn(),
	trackGenerationAction: vi.fn(),
}));
vi.mock("../../effects/lib/editor-context", () => ({
	useEffectEditor: () => null,
	useEffectEditorBinding: () => {},
}));
vi.mock("../lib/tool-prompt-context", () => ({
	useToolPrompt: () => null,
	useToolPromptBinding: () => {},
}));
vi.mock("../../landing/lib/use-showcase-prompt", () => ({
	useShowcasePrompt: () => "A paper landscape",
}));
vi.mock("../lib/generation-mode-context", () => ({ useGenerationMode: () => null }));
vi.mock("../lib/preview-timing", () => ({ observeGenerationJobVisibility: state.visibility }));
vi.mock("../hooks/use-model-navigation", () => ({
	useModelNavigation: () => ({ unavailable: false }),
	useRequestedImageModel: () => null,
	replaceImageModelInUrl: vi.fn(),
}));
vi.mock("../hooks/use-generation", () => ({
	useGeneration: () => ({
		catalog: {
			data: {
				products: [
					{
						key: "image-nano-banana-2-lite",
						label: "Nano",
						credits: 5,
						skuMatrix: {
							defaultSkuKey: "nano-banana-2-lite-1k",
							cells: [
								{
									skuKey: "nano-banana-2-lite-1k",
									credits: 5,
									aspectRatios: ["auto", "1:1"],
									controls: [],
								},
							],
						},
					},
					{
						key: "image-gpt-image-2-5-sunburst",
						label: "GPT Image 2.5 Sunburst",
						credits: 7,
						skuMatrix: {
							defaultSkuKey: "gpt-image-2-5-sunburst-1k",
							cells: [
								{
									skuKey: "gpt-image-2-5-sunburst-1k",
									credits: 7,
									aspectRatios: ["auto", "1:1"],
									controls: [],
								},
							],
						},
					},
				],
			},
		},
		creditAccount: {
			data: { spendableCredits: state.spendableCredits },
			isError: state.creditFailed,
		},
		imagePass: {
			data: { available: state.passAvailable, reserved: state.passReserved },
			isError: state.passFailed,
		},
		quote: null,
		createQuote: { isPending: false, error: null },
		createGeneration: {
			mutateAsync: state.mutateAsync,
			isPending: state.generationPending,
			error: null,
		},
		beginNewAction: state.beginNewAction,
	}),
}));

import { resolveEditorAllowedProductKeys } from "../lib/editor-recovery";
import { PromptPanel } from "./editor/PromptPanel";
import { GenerationForm } from "./GenerationForm";
import { ImageFundingSelector, type ImageFundingSource } from "./ImageFundingSelector";
import { ImageOutputSettings } from "./ImageOutputSettings";

const accepted = { job: { id: "accepted-job" }, replayed: false };
function render(
	onCreated = vi.fn(),
	jobId: string | null = null,
	allowedProductKeys?: Parameters<typeof GenerationForm>[0]["allowedProductKeys"],
) {
	state.cursor = 0;
	return GenerationForm({ onCreated, jobId, allowedProductKeys });
}
function unmount() {
	for (const slot of state.slots) slot.cleanup?.();
}
async function flush() {
	for (let count = 0; count < 20; count++) await Promise.resolve();
}
function find(
	root: ReactElement,
	type: unknown,
): ReactElement<Record<string, (...args: never[]) => void>> {
	if (root.type === type) return root as ReactElement<Record<string, (...args: never[]) => void>>;
	for (const child of React.Children.toArray(
		(root.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return find(child, type);
		} catch {
			/* Continue siblings. */
		}
	}
	throw new Error("element missing");
}
function submit(element: ReturnType<typeof render>) {
	(element.props.onSubmit as () => void)();
}
function fundingMarkup(element: ReturnType<typeof render>) {
	return renderToStaticMarkup(find(element, ImageFundingSelector));
}
beforeEach(() => {
	state.ownerId = "owner-a";
	state.loaded = true;
	state.passAvailable = 3;
	state.passReserved = 0;
	state.passFailed = false;
	state.creditFailed = false;
	state.spendableCredits = "100";
	state.generationPending = false;
	state.slots = [];
	state.cursor = 0;
	state.values = {
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		prompt: "A paper landscape",
		aspectRatio: "auto",
		sourceAssetId: "",
	};
	state.mutateAsync.mockReset().mockResolvedValue(accepted);
	state.beginNewAction.mockClear();
	state.visibility.mockReset();
	vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
	vi.stubGlobal("document", {
		getElementById: vi.fn().mockReturnValue({ id: "current-editor-result" }),
	});
});
vi.mock("react-hook-form", () => ({
	useForm: () => ({
		watch: () => state.values,
		getValues: () => state.values,
		handleSubmit: (fn: (value: unknown) => void) => () => fn(state.values),
		setValue: (key: string, value: string) => {
			Object.assign(state.values, { [key]: value });
		},
		unregister: vi.fn(),
	}),
}));
afterEach(() => {
	unmount();
	vi.unstubAllGlobals();
});
describe("GenerationForm submission callbacks", () => {
	it("submits Sunburst 1K with shared credits for a funded owner without a subscription", async () => {
		state.spendableCredits = "377";
		state.values.productKey = "image-gpt-image-2-5-sunburst";
		state.values.skuKey = "gpt-image-2-5-sunburst-1k";
		state.values.aspectRatio = "1:1";
		const onCreated = vi.fn();
		submit(render(onCreated, null, resolveEditorAllowedProductKeys(undefined, undefined)));
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				productKey: "image-gpt-image-2-5-sunburst",
				fundingSource: "CREDITS",
				expectedCredits: "7",
				input: expect.objectContaining({
					skuKey: "gpt-image-2-5-sunburst-1k",
					aspectRatio: "1:1",
				}),
			}),
		);
		expect(onCreated).toHaveBeenCalledWith("accepted-job");
	});
	it("does not automatically spend image passes when credits are the selected source", async () => {
		submit(render());
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "CREDITS" }),
		);
	});
	it("accepts an explicit image pass choice independently of plan product access", async () => {
		const element = render(vi.fn(), null, []);
		(find(element, ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		submit(render(vi.fn(), null, []));
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ fundingSource: "IMAGE_PASS", expectedCredits: "5" }),
		);
		expect(state.beginNewAction).toHaveBeenCalled();
	});
	it("keeps an exhausted pass choice and blocks submission rather than falling back to credits", async () => {
		(find(render(), ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		state.passAvailable = 0;
		const element = render();
		expect(find(element, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
		submit(element);
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
	it("shows only a successfully read credit balance in the funding choice", () => {
		expect(find(render(), ImageFundingSelector).props.creditsAvailable).toBe("100");
		state.creditFailed = true;
		expect(find(render(), ImageFundingSelector).props.creditsAvailable).toBeUndefined();
	});
	it("passes reserved balances through and preserves the draft as the selector hides and reappears", () => {
		state.passAvailable = 0;
		let element = render();
		expect(fundingMarkup(element)).toBe("");
		(find(element, PromptPanel).props.onChange as (prompt: string) => void)("My unsent draft");
		(find(element, ImageOutputSettings).props.onChange as (ratio: string) => void)("1:1");
		state.passReserved = 1;
		element = render();
		expect(find(element, ImageFundingSelector).props.reserved).toBe(1);
		expect(fundingMarkup(element)).toContain("fundingReserved");
		expect(find(element, PromptPanel).props.value).toBe("My unsent draft");
		expect(state.values.aspectRatio).toBe("1:1");
		state.passReserved = 0;
		element = render();
		expect(fundingMarkup(element)).toBe("");
		expect(find(element, PromptPanel).props.value).toBe("My unsent draft");
		expect(state.values.aspectRatio).toBe("1:1");
		expect(find(element, ImageFundingSelector).props.value).toBe("CREDITS");
	});
	it("blocks a failed pass choice until credits are explicitly selected without losing the prompt", async () => {
		let element = render();
		(find(element, PromptPanel).props.onChange as (prompt: string) => void)("Keep this draft");
		(find(element, ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		state.passFailed = true;
		element = render();
		expect(find(element, ImageFundingSelector).props.value).toBe("IMAGE_PASS");
		expect(fundingMarkup(element)).toContain("balanceError");
		submit(element);
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
		(find(element, ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"CREDITS",
		);
		element = render();
		expect(find(element, PromptPanel).props.value).toBe("Keep this draft");
		submit(element);
		await flush();
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				fundingSource: "CREDITS",
				input: expect.objectContaining({ prompt: "Keep this draft" }),
			}),
		);
	});
	it("disables funding controls while generation is pending", () => {
		state.generationPending = true;
		expect(find(render(), ImageFundingSelector).props.disabled).toBe(true);
	});
	it("resets the funding choice when the signed-in account changes", () => {
		(find(render(), ImageFundingSelector).props.onChange as (source: ImageFundingSource) => void)(
			"IMAGE_PASS",
		);
		state.ownerId = "owner-b";
		state.passAvailable = 0;
		state.passReserved = 0;
		expect(find(render(), ImageFundingSelector).props.value).toBe("CREDITS");
		expect(fundingMarkup(render())).toBe("");
	});
	it("selects the accepted job and observes only that job's committed task region", async () => {
		const onCreated = vi.fn();
		submit(render(onCreated));
		await flush();
		expect(onCreated).toHaveBeenCalledWith("accepted-job");
		expect(state.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedCredits: "5",
				input: expect.objectContaining({ prompt: "A paper landscape" }),
			}),
		);
		expect(state.visibility).not.toHaveBeenCalled();
		render(onCreated, "accepted-job");
		expect(state.visibility).toHaveBeenCalledWith(
			"accepted-job",
			expect.objectContaining({ id: "current-editor-result" }),
			expect.any(Function),
		);
	});
	it("blocks duplicate clicks until the accepted response and ignores null results", async () => {
		let resolve!: (value: typeof accepted | null) => void;
		state.mutateAsync.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const onCreated = vi.fn(),
			element = render(onCreated);
		submit(element);
		submit(element);
		expect(state.mutateAsync).toHaveBeenCalledTimes(1);
		resolve(null);
		await flush();
		expect(onCreated).not.toHaveBeenCalled();
	});
	it.each(["job", "owner", "unmount"])(
		"invalidates a pending visibility callback after %s changes",
		async (boundary) => {
			const onCreated = vi.fn();
			submit(render(onCreated));
			await flush();
			render(onCreated, "accepted-job");
			const isCurrent = state.visibility.mock.calls[0][2] as () => boolean;
			expect(isCurrent()).toBe(true);
			if (boundary === "unmount") unmount();
			else {
				if (boundary === "owner") state.ownerId = "owner-b";
				render(onCreated, boundary === "job" ? "another-job" : "accepted-job");
			}
			expect(isCurrent()).toBe(false);
		},
	);
	it.each(["prompt", "ratio", "owner", "a-b-a", "unmount"])(
		"does not select an old accepted response after %s",
		async (boundary) => {
			let resolve!: (value: typeof accepted) => void;
			state.mutateAsync.mockReturnValueOnce(
				new Promise((done) => {
					resolve = done;
				}),
			);
			const onCreated = vi.fn(),
				element = render(onCreated);
			submit(element);
			if (boundary === "prompt")
				(find(element, PromptPanel).props.onChange as (prompt: string) => void)("New prompt");
			else if (boundary === "ratio")
				(find(element, ImageOutputSettings).props.onChange as (ratio: string) => void)("1:1");
			else if (boundary === "unmount") unmount();
			else {
				state.ownerId = "owner-b";
				render(onCreated);
				if (boundary === "a-b-a") {
					state.ownerId = "owner-a";
					render(onCreated);
				}
			}
			resolve(accepted);
			await flush();
			expect(onCreated).not.toHaveBeenCalled();
		},
	);
	it("rejects a response even if the account changes in the promise-to-form continuation gap", async () => {
		const onCreated = vi.fn();
		state.mutateAsync.mockImplementationOnce(() => {
			const result = Promise.resolve(accepted);
			queueMicrotask(() => {
				state.ownerId = "owner-b";
				render(onCreated);
			});
			return result;
		});
		submit(render(onCreated));
		await flush();
		expect(onCreated).not.toHaveBeenCalled();
	});
	it("does not submit while identity is unresolved", async () => {
		state.loaded = false;
		submit(render());
		await flush();
		expect(state.mutateAsync).not.toHaveBeenCalled();
	});
});
