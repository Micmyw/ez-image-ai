import { afterEach, describe, expect, it, vi } from "vitest";

import { observeNearViewport } from "./use-near-viewport";

afterEach(() => vi.unstubAllGlobals());

describe("private thumbnail viewport boundary", () => {
	it("waits for intersection and disconnects its observer on cleanup", () => {
		let notify: IntersectionObserverCallback | undefined;
		const observe = vi.fn();
		const disconnect = vi.fn();
		const create = vi.fn();
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
					notify = callback;
					create(options);
				}
				observe = observe;
				disconnect = disconnect;
			},
		);
		const element = {} as Element;
		const update = vi.fn();
		const cleanup = observeNearViewport(element, update);
		expect(observe).toHaveBeenCalledWith(element);
		expect(create).toHaveBeenCalledWith({ rootMargin: "240px" });
		expect(update).not.toHaveBeenCalled();
		notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
		expect(update).toHaveBeenLastCalledWith(true);
		notify?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
		expect(update).toHaveBeenLastCalledWith(false);
		cleanup();
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it("keeps previews usable in a browser without IntersectionObserver", () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		const update = vi.fn();
		observeNearViewport({} as Element, update)();
		expect(update).toHaveBeenCalledWith(true);
	});
});
