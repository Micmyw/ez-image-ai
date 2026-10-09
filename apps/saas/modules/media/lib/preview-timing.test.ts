import { afterEach, describe, expect, it, vi } from "vitest";

import {
	recordGenerationAccepted,
	observeGenerationJobVisibility,
	recordOutputReceived,
	recordOutputLoaded,
} from "./preview-timing";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("preview timing", () => {
	it.each(["offscreen", "hidden", "scroll-fallback"])(
		"observes later first visibility after %s and releases observers",
		(initial) => {
			const log = vi.spyOn(console, "info").mockImplementation(() => {});
			const now = vi.spyOn(performance, "now").mockReturnValue(100);
			const frames: FrameRequestCallback[] = [];
			const events = new Map<string, () => void>();
			const addEventListener = vi.fn((event: string, callback: () => void) =>
				events.set(event, callback),
			);
			const removeEventListener = vi.fn((event: string) => events.delete(event));
			const page = {
				visibilityState: initial === "hidden" ? "hidden" : "visible",
				addEventListener,
				removeEventListener,
			};
			vi.stubGlobal("document", page);
			vi.stubGlobal("window", {
				innerWidth: 1000,
				innerHeight: 800,
				addEventListener,
				removeEventListener,
			});
			vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
			const disconnect = vi.fn();
			let intersect!: () => void;
			vi.stubGlobal(
				"IntersectionObserver",
				initial === "scroll-fallback"
					? undefined
					: class {
							constructor(callback: () => void) {
								intersect = callback;
							}
							observe() {}
							disconnect = disconnect;
						},
			);
			let top = initial === "hidden" ? 0 : 900;
			const element = visibleTaskRegion();
			element.getBoundingClientRect = () =>
				({ width: 100, height: 100, left: 0, right: 100, top, bottom: top + 100 }) as DOMRect;
			const jobId = `later-${initial}`;
			recordGenerationAccepted(jobId, 50);
			const cancel = observeGenerationJobVisibility(jobId, element);
			frames.shift()!(0);
			frames.shift()!(0);
			expect(log.mock.calls.map((call) => call[1].stage)).toEqual(["accepted"]);
			top = 100;
			page.visibilityState = "visible";
			now.mockReturnValue(160);
			if (initial === "hidden") events.get("visibilitychange")!();
			else if (initial === "scroll-fallback") events.get("scroll")!();
			else intersect();
			frames.shift()!(0);
			now.mockReturnValue(180);
			frames.shift()!(0);
			expect(log).toHaveBeenLastCalledWith(
				"media.generation.timing",
				expect.objectContaining({ jobId, stage: "job-visible", elapsedMs: 80 }),
			);
			expect(events.size).toBe(0);
			if (initial !== "scroll-fallback") expect(disconnect).toHaveBeenCalled();
			cancel?.();
		},
	);
	it("measures accepted response to task region visibility independently of output preview", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const now = vi.spyOn(performance, "now").mockReturnValue(100);
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
		vi.stubGlobal("document", { visibilityState: "visible" });
		vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
		const element = visibleTaskRegion();
		recordGenerationAccepted("task-visible-job", 50);
		observeGenerationJobVisibility("task-visible-job", element);
		now.mockReturnValue(110);
		frames.shift()!(0);
		now.mockReturnValue(132);
		frames.shift()!(0);
		expect(log).toHaveBeenLastCalledWith("media.generation.timing", {
			jobId: "task-visible-job",
			stage: "job-visible",
			elapsedMs: 32,
			startBoundary: "submit-generation-response",
			visibilityMethod: "task-region-plus-two-animation-frames",
		});
		observeGenerationJobVisibility("task-visible-job", element);
		expect(frames).toHaveLength(0);
		recordOutputReceived("task-visible-job", "task-output");
		expect(log).toHaveBeenLastCalledWith(
			"media.preview.timing",
			expect.objectContaining({ jobId: "task-visible-job", stage: "received", elapsedMs: 0 }),
		);
	});
	it.each([
		"cancel",
		"hidden",
		"removed",
		"offscreen",
		"style-hidden",
		"diagnostic-failure",
		"current-changed",
	])("does not claim task visible after %s", (boundary) => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
		vi.stubGlobal("document", { visibilityState: boundary === "hidden" ? "hidden" : "visible" });
		vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
		const element = visibleTaskRegion();
		if (boundary === "removed") Object.assign(element, { isConnected: false });
		if (boundary === "offscreen")
			element.getBoundingClientRect = () =>
				({ width: 100, height: 100, left: 0, right: 100, top: 900, bottom: 1000 }) as DOMRect;
		if (boundary === "style-hidden") element.checkVisibility = () => false;
		if (boundary === "diagnostic-failure")
			element.checkVisibility = () => {
				throw new Error("diagnostic");
			};
		const jobId = `task-${boundary}`;
		recordGenerationAccepted(jobId, performance.now());
		let isCurrent = true;
		const cancel = observeGenerationJobVisibility(jobId, element, () => isCurrent);
		if (boundary === "current-changed") isCurrent = false;
		if (boundary === "cancel") cancel?.();
		while (frames.length) expect(() => frames.shift()!(0)).not.toThrow();
		expect(log.mock.calls.map((call) => call[1].stage)).toEqual(["accepted"]);
	});
	it("does not turn successful admission or preview delivery into failure when logging throws", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {
			throw new Error("sink unavailable");
		});
		expect(() => recordGenerationAccepted("logger-failure-job", performance.now())).not.toThrow();
		expect(() => recordOutputReceived("logger-failure-job", "logger-failure-asset")).not.toThrow();
		log.mockRestore();
	});
	it("records browser submission-to-acceptance duration by job id without request contents", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(performance, "now").mockReturnValue(450);
		recordGenerationAccepted("accepted-job", 100);
		expect(log).toHaveBeenCalledWith("media.generation.timing", {
			jobId: "accepted-job",
			stage: "accepted",
			elapsedMs: 350,
			startBoundary: "submit-generation-call",
		});
	});
	it("reads the loaded image resource timing and logs only its offset from output receipt", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const now = vi.spyOn(performance, "now").mockReturnValue(100);
		const imageUrl = "https://private.example.test/image?credential=SIGNED_URL_SENTINEL";
		const entries = vi.spyOn(performance, "getEntriesByName").mockReturnValue([
			{
				entryType: "resource",
				initiatorType: "img",
				startTime: 130,
			} as PerformanceResourceTiming,
		]);
		recordOutputReceived("resource-job", "asset");
		now.mockReturnValue(300);
		recordOutputLoaded("resource-job", "asset", { currentSrc: imageUrl } as HTMLImageElement);
		expect(entries).toHaveBeenCalledWith(imageUrl, "resource");
		expect(log).toHaveBeenLastCalledWith(
			"media.preview.timing",
			expect.objectContaining({
				stage: "loaded",
				requestStartMs: 30,
				requestStartSource: "resource-timing",
				loadMs: 200,
			}),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain(imageUrl);
		expect(JSON.stringify(log.mock.calls)).not.toContain("SIGNED_URL_SENTINEL");
	});
	it.each([
		{ entries: [] },
		{
			entries: [
				{
					entryType: "resource",
					initiatorType: "img",
					startTime: 50,
					duration: 10,
					name: "synthetic-image",
					toJSON: () => ({}),
				},
			],
		},
	])("marks missing or older resource timing as unmeasured: %j", ({ entries }) => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const now = vi.spyOn(performance, "now").mockReturnValue(100);
		vi.spyOn(performance, "getEntriesByName").mockReturnValue(entries);
		const jobId = `unmeasured-${entries.length}`;
		recordOutputReceived(jobId, "asset");
		now.mockReturnValue(300);
		recordOutputLoaded(jobId, "asset", {
			currentSrc: "https://private.example.test/image",
		} as HTMLImageElement);
		expect(log).toHaveBeenLastCalledWith(
			"media.preview.timing",
			expect.objectContaining({
				stage: "loaded",
				requestStartMs: null,
				requestStartSource: "unmeasured",
			}),
		);
	});
	it("does not interrupt image load bookkeeping when resource timing is unavailable", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(performance, "getEntriesByName").mockImplementation(() => {
			throw new Error("PRIVATE_RESOURCE_FAILURE");
		});
		recordOutputReceived("unavailable-resource", "asset");
		expect(() =>
			recordOutputLoaded("unavailable-resource", "asset", {
				currentSrc: "https://private.example.test/image",
			} as HTMLImageElement),
		).not.toThrow();
		expect(log).toHaveBeenLastCalledWith(
			"media.preview.timing",
			expect.objectContaining({
				stage: "loaded",
				requestStartMs: null,
				requestStartSource: "unmeasured",
			}),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_RESOURCE_FAILURE");
	});
	it("records receive/load/two-frame visible without URLs or content", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
		vi.stubGlobal("document", { visibilityState: "visible" });
		vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
		const element = {
			isConnected: true,
			naturalWidth: 100,
			checkVisibility: () => true,
			getBoundingClientRect: () => ({
				width: 100,
				height: 100,
				left: 0,
				right: 100,
				top: 0,
				bottom: 100,
			}),
		} as unknown as HTMLImageElement;
		recordOutputReceived("timing-job", "asset", "request");
		recordOutputLoaded("timing-job", "asset", element);
		expect(log.mock.calls.map((call) => call[1].stage)).toEqual(["received", "loaded"]);
		frames.shift()!(0);
		frames.shift()!(0);
		expect(log).toHaveBeenLastCalledWith(
			"media.preview.timing",
			expect.objectContaining({
				jobId: "timing-job",
				assetId: "asset",
				requestId: "request",
				stage: "visible",
			}),
		);
		recordOutputReceived("timing-job", "asset", "another-poll");
		expect(log).toHaveBeenCalledTimes(3);
		log.mockRestore();
	});
	it("does not claim visible when the loaded image was removed before paint", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
		vi.stubGlobal("document", { visibilityState: "visible" });
		const element = { isConnected: true } as HTMLImageElement;
		recordOutputReceived("removed-job", "asset");
		recordOutputLoaded("removed-job", "asset", element);
		Object.assign(element, { isConnected: false });
		frames.shift()!(0);
		frames.shift()!(0);
		expect(log.mock.calls.map((call) => call[1].stage)).toEqual(["received", "loaded"]);
		log.mockRestore();
	});
});

function visibleTaskRegion() {
	return {
		isConnected: true,
		checkVisibility: () => true,
		getBoundingClientRect: () => ({
			width: 100,
			height: 100,
			left: 0,
			right: 100,
			top: 0,
			bottom: 100,
		}),
	} as unknown as HTMLElement;
}
