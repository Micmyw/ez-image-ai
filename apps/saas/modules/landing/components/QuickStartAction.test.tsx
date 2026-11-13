import type { MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LANDING_PROMPT_SELECTED_EVENT } from "../lib/prompt-selection";
import { QuickStartAction } from "./QuickStartAction";

const tracker = vi.hoisted(() => vi.fn(async () => "blocked"));
vi.mock("@repo/utils/lib/growth-analytics-browser", () => ({ trackBrowserGrowthEvent: tracker }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useRef: (current: unknown) => ({ current }),
	useEffect: () => {},
}));

let browser: EventTarget & {
	location: URL;
	history: { pushState: ReturnType<typeof vi.fn> };
	matchMedia: ReturnType<typeof vi.fn>;
};
const focus = vi.fn();
const scrollIntoView = vi.fn();
const prompt = "Restore this old photograph.";
function click(modifiers = {}) {
	const event = { preventDefault: vi.fn(), ...modifiers };
	const link = QuickStartAction({
		idea: "restore-photo",
		href: "/create?example=restore-photo",
		prompt,
		children: "Restore",
	});
	link.props.onClick(event as unknown as MouseEvent<HTMLAnchorElement>);
	return event;
}

describe("homepage quick-start handoff", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		browser = Object.assign(new EventTarget(), {
			location: new URL("https://example.test/?mode=video&job=image-1&videoJob=video-1&lang=de"),
			history: { pushState: vi.fn() },
			matchMedia: vi.fn(() => ({ matches: true })),
		});
		vi.stubGlobal("window", browser);
		vi.stubGlobal("document", {
			getElementById: () => ({ querySelector: () => ({ focus }), scrollIntoView }),
		});
		vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
			fn();
			return 1;
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	it("applies once, returns to image mode, and retains both active job identities", () => {
		const received = vi.fn((event: Event) => {
			expect((event as CustomEvent).detail).toEqual({ prompt });
			event.preventDefault();
		});
		browser.addEventListener(LANDING_PROMPT_SELECTED_EVENT, received);
		expect(click().preventDefault).toHaveBeenCalledOnce();
		expect(received).toHaveBeenCalledOnce();
		expect(browser.history.pushState).toHaveBeenCalledWith(
			null,
			"",
			"/?job=image-1&videoJob=video-1&lang=de",
		);
		expect(focus).not.toHaveBeenCalled();
		expect(tracker).toHaveBeenCalledWith({
			name: "homepage_idea_selected",
			properties: {
				homepageIdea: "restore-photo",
				homepagePlacement: "quick-start",
				status: "selected",
			},
		});
	});
	it("focuses the current image prompt immediately without another mode navigation", () => {
		browser.location = new URL("https://example.test/");
		browser.addEventListener(LANDING_PROMPT_SELECTED_EVENT, (event) => event.preventDefault());
		expect(click().preventDefault).toHaveBeenCalledOnce();
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
		expect(browser.history.pushState).not.toHaveBeenCalled();
	});
	it("uses the real destination when an editor has not mounted yet", () => {
		expect(click().preventDefault).not.toHaveBeenCalled();
		expect(browser.history.pushState).not.toHaveBeenCalled();
		expect(focus).not.toHaveBeenCalled();
	});
	it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"])("preserves native %s navigation", (key) => {
		const received = vi.fn((event: Event) => event.preventDefault());
		browser.addEventListener(LANDING_PROMPT_SELECTED_EVENT, received);
		expect(click({ [key]: true }).preventDefault).not.toHaveBeenCalled();
		expect(received).not.toHaveBeenCalled();
	});
});
