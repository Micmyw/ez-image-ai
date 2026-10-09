import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	loaded: true,
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
				],
			},
		},
		creditAccount: { data: { spendableCredits: "100" } },
		quote: null,
		createQuote: { isPending: false, error: null },
		createGeneration: { mutateAsync: state.mutateAsync, isPending: false, error: null },
		beginNewAction: state.beginNewAction,
	}),
}));

import { PromptPanel } from "./editor/PromptPanel";
import { GenerationForm } from "./GenerationForm";
import { ImageOutputSettings } from "./ImageOutputSettings";

const accepted = { job: { id: "accepted-job" }, replayed: false };
function render(onCreated = vi.fn(), jobId: string | null = null) {
	state.cursor = 0;
	return GenerationForm({ onCreated, jobId });
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
beforeEach(() => {
	state.ownerId = "owner-a";
	state.loaded = true;
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
