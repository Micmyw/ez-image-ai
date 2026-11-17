import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
	state: undefined as unknown,
	ref: null as { current: unknown } | null,
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useRef: (initial: unknown) => (harness.ref ??= { current: initial }),
	useState: (initial: unknown) => {
		harness.state ??= initial;
		return [
			harness.state,
			(next: unknown) => {
				harness.state =
					typeof next === "function"
						? (next as (current: unknown) => unknown)(harness.state)
						: next;
			},
		];
	},
	useCallback: (callback: unknown) => callback,
	useMemo: (factory: () => unknown) => factory(),
}));

import { ToolPromptProvider, type ToolPromptOptions } from "./tool-prompt-context";

type Binding = {
	prompt: string;
	busy: boolean;
	applyPrompt: (prompt: string, options?: ToolPromptOptions) => boolean | void;
};
type Tool = {
	prompt: string;
	busy: boolean;
	ready: boolean;
	bind: (binding: RefObject<Binding>) => () => void;
	apply: (prompt: string, options?: ToolPromptOptions) => boolean;
	report: (prompt: string, busy: boolean) => void;
};

function value(): Tool {
	const element = ToolPromptProvider({ initialPrompt: "Photo preset", children: null });
	return (element.props as { value: Tool }).value;
}

describe("tool prompt draft synchronization", () => {
	beforeEach(() => {
		harness.state = undefined;
		harness.ref = null;
	});
	it("publishes the restored binding draft immediately when its initial prompt differs", () => {
		const tool = value();
		tool.bind({ current: { prompt: "Restored scene preset", busy: true, applyPrompt: vi.fn() } });
		expect(value()).toMatchObject({ prompt: "Restored scene preset", busy: true, ready: true });
	});
	it.each([true, undefined])(
		"reports a successful apply immediately before child effects (%s)",
		(success) => {
			const applyPrompt = vi.fn<Binding["applyPrompt"]>().mockReturnValue(success);
			const tool = value();
			tool.bind({ current: { prompt: "Photo preset", busy: false, applyPrompt } });
			expect(tool.apply("Scene preset", { aspectRatio: "16:9" })).toBe(true);
			expect(value()).toMatchObject({ prompt: "Scene preset", ready: true, busy: false });
			expect(applyPrompt).toHaveBeenCalledExactlyOnceWith("Scene preset", { aspectRatio: "16:9" });
		},
	);
	it("leaves the current draft intact when the editor rejects an apply", () => {
		const tool = value();
		tool.bind({ current: { prompt: "Photo preset", busy: false, applyPrompt: () => false } });
		expect(tool.apply("Unsupported scene")).toBe(false);
		expect(value().prompt).toBe("Photo preset");
	});
	it("continues reporting manual draft and busy changes", () => {
		const tool = value();
		tool.report("Manually edited prompt", true);
		expect(value()).toMatchObject({ prompt: "Manually edited prompt", busy: true });
	});
});
