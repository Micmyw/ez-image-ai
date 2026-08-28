import type { DependencyList, EffectCallback, MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookRuntime = vi.hoisted(() => ({
	cleanup: undefined as ReturnType<EffectCallback>,
	container: {} as HTMLElement,
	deps: undefined as DependencyList | undefined,
}));

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useEffect: (effect: EffectCallback, deps?: DependencyList) => {
			const changed =
				!hookRuntime.deps ||
				!deps ||
				deps.length !== hookRuntime.deps.length ||
				deps.some((dependency, index) => !Object.is(dependency, hookRuntime.deps?.[index]));
			if (!changed) return;
			hookRuntime.cleanup?.();
			hookRuntime.deps = deps;
			hookRuntime.cleanup = effect();
		},
		useRef: () => ({ current: hookRuntime.container }) as MutableRefObject<HTMLElement>,
	};
});

import { Turnstile } from "@repo/ui/components/turnstile";

describe("shared Turnstile recovery", () => {
	beforeEach(() => {
		hookRuntime.cleanup = undefined;
		hookRuntime.deps = undefined;
		hookRuntime.container = {} as HTMLElement;
	});

	afterEach(() => {
		hookRuntime.cleanup?.();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("removes and renders a fresh challenge when the controlled reset key changes", () => {
		const render = vi.fn(() => `widget-${render.mock.calls.length}`);
		const remove = vi.fn();
		vi.stubGlobal("window", { turnstile: { render, remove } });

		const renderChallenge = (resetKey: number) => {
			const props = {
				siteKey: "site-key",
				action: "guest_upload",
				ariaLabel: "Verify upload",
				resetKey,
				onToken: vi.fn(),
			} as Parameters<typeof Turnstile>[0] & { resetKey: number };
			Turnstile(props);
		};

		renderChallenge(0);
		renderChallenge(1);

		expect(render).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledWith("widget-1");
	});

	it("surfaces script loading failure through the shared error callback", () => {
		const listeners = new Map<string, EventListener>();
		const addEventListener = vi.fn((type: string, listener: EventListener) =>
			listeners.set(type, listener),
		);
		const script = {
			addEventListener,
			removeEventListener: vi.fn(),
			async: false,
			defer: false,
			src: "",
		} as unknown as HTMLScriptElement;
		const onError = vi.fn();
		vi.stubGlobal("window", {});
		vi.stubGlobal("document", {
			createElement: vi.fn(() => script),
			head: { append: vi.fn() },
			querySelector: vi.fn(() => null),
		});

		Turnstile({
			siteKey: "site-key",
			action: "guest_upload",
			ariaLabel: "Verify upload",
			onToken: vi.fn(),
			onError,
		});
		listeners.get("error")?.(new Event("error"));

		expect(addEventListener).toHaveBeenCalledWith("error", expect.any(Function));
		expect(onError).toHaveBeenCalledOnce();
	});
});
