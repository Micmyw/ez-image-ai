import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EffectSlot = {
	deps?: readonly unknown[];
	cleanup?: () => void;
};
const runtime = vi.hoisted(() => ({
	pathname: "/create",
	refCursor: 0,
	effectCursor: 0,
	refs: [] as { current: unknown }[],
	slots: [] as EffectSlot[],
	pending: [] as { index: number; effect: () => void | (() => void); deps?: readonly unknown[] }[],
}));

vi.mock("next/navigation", () => ({ usePathname: () => runtime.pathname }));
vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useRef: <T,>(initial: T) => {
			const index = runtime.refCursor++;
			runtime.refs[index] ??= { current: initial };
			return runtime.refs[index];
		},
		useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
			runtime.pending.push({ index: runtime.effectCursor++, effect, deps });
		},
	};
});

import { ArticleNavigationBoundary } from "./ArticleNavigationBoundary";

const origin = "https://ezimageai.com";
const article = "/blog/tesco-ai-meal-planning-assistant";

type Listener = { callback: EventListener; capture: boolean };
function surface() {
	const listeners = new Map<string, Listener[]>();
	return {
		listeners,
		addEventListener: vi.fn((type: string, callback: EventListener, capture = false) => {
			listeners.set(type, [...(listeners.get(type) ?? []), { callback, capture }]);
		}),
		removeEventListener: vi.fn((type: string, callback: EventListener, capture = false) => {
			listeners.set(
				type,
				(listeners.get(type) ?? []).filter(
					(listener) => listener.callback !== callback || listener.capture !== capture,
				),
			);
		}),
		invoke(type: string, event: object) {
			for (const listener of listeners.get(type) ?? []) listener.callback(event as Event);
		},
	};
}

class ElementFixture {
	constructor(private anchor: AnchorFixture | null = null) {}
	closest() {
		return this.anchor;
	}
}
class AnchorFixture extends ElementFixture {
	constructor(
		readonly href: string,
		private attributes: Record<string, string> = {},
	) {
		super();
	}
	getAttribute(name: string) {
		return this.attributes[name] ?? null;
	}
	hasAttribute(name: string) {
		return name in this.attributes;
	}
}

let current: URL;
let documentSurface: ReturnType<typeof surface>;
let windowSurface: ReturnType<typeof surface>;
let trace: string[];
let frames: ReturnType<typeof frameFixture>[];
let assign: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let navigationName: string;

function frameFixture() {
	let removed = false;
	return {
		get removed() {
			return removed;
		},
		set src(value: string) {
			trace.push(`src:${value}`);
		},
		removeAttribute: vi.fn((name: string) => trace.push(`attribute:${name}`)),
		remove: vi.fn(() => {
			removed = true;
			trace.push("remove");
		}),
	};
}

function render() {
	runtime.refCursor = 0;
	runtime.effectCursor = 0;
	runtime.pending = [];
	expect(ArticleNavigationBoundary()).toBeNull();
	for (const pending of runtime.pending) {
		const previous = runtime.slots[pending.index];
		if (
			previous?.deps &&
			pending.deps &&
			previous.deps.length === pending.deps.length &&
			previous.deps.every((dependency, index) => Object.is(dependency, pending.deps?.[index]))
		)
			continue;
		previous?.cleanup?.();
		const cleanup = pending.effect();
		runtime.slots[pending.index] = {
			deps: pending.deps,
			cleanup: typeof cleanup === "function" ? cleanup : undefined,
		};
	}
}

function navigate(path: string) {
	current = new URL(path, origin);
	runtime.pathname = current.pathname;
}

function click(href: string, attributes?: Record<string, string>) {
	const anchor = new AnchorFixture(new URL(href, current).href, attributes);
	const event = {
		target: new ElementFixture(anchor),
		button: 0,
		defaultPrevented: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		preventDefault: vi.fn(),
		stopImmediatePropagation: vi.fn(),
	};
	documentSurface.invoke("click", event);
	return event;
}

beforeEach(() => {
	runtime.pathname = "/create";
	runtime.refs = [];
	runtime.slots = [];
	trace = [];
	frames = [];
	current = new URL(`${origin}/create`);
	navigationName = current.href;
	documentSurface = surface();
	windowSurface = surface();
	assign = vi.fn(() => trace.push("assign"));
	reload = vi.fn(() => trace.push("reload"));
	vi.stubGlobal("Element", ElementFixture);
	vi.stubGlobal("document", {
		...documentSurface,
		querySelectorAll: vi.fn(() => frames.filter((frame) => !frame.removed)),
	});
	vi.stubGlobal("performance", {
		getEntriesByType: vi.fn(() => [{ name: navigationName }]),
	});
	vi.stubGlobal("window", {
		...windowSurface,
		location: {
			get href() {
				return current.href;
			},
			get origin() {
				return current.origin;
			},
			get pathname() {
				return current.pathname;
			},
			assign,
			reload,
		},
	});
});

afterEach(() => {
	for (const slot of runtime.slots) slot.cleanup?.();
	vi.unstubAllGlobals();
});

describe("article navigation event boundary", () => {
	it("captures article entry before the SPA handler and assigns a new document", () => {
		render();
		const event = click(`${article}?lang=de#sources`);
		expect(documentSurface.listeners.get("click")?.[0]?.capture).toBe(true);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
		expect(assign).toHaveBeenCalledWith(`${origin}${article}?lang=de#sources`);
		expect(reload).not.toHaveBeenCalled();
	});

	it("destroys owned browsing contexts synchronously before an article exit", () => {
		navigate(article);
		navigationName = current.href;
		render();
		frames = [frameFixture()];
		click("/pricing");
		expect(trace).toEqual(["attribute:srcdoc", "src:about:blank", "remove", "assign"]);
		expect(assign).toHaveBeenCalledWith(`${origin}/pricing`);
	});

	it("does not intercept normal product navigation, named targets or downloads", () => {
		render();
		for (const event of [
			click("/pricing"),
			click(article, { target: "_blank" }),
			click(article, { download: "" }),
			click(article, { "aria-disabled": "true" }),
		]) {
			expect(event.preventDefault).not.toHaveBeenCalled();
			expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
		}
		expect(assign).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it("reloads programmatic article entry after usePathname changes", () => {
		render();
		navigate(article);
		frames = [frameFixture()];
		render();
		expect(trace).toEqual(["attribute:srcdoc", "src:about:blank", "remove", "reload"]);
		expect(reload).toHaveBeenCalledOnce();
		render();
		expect(reload).toHaveBeenCalledOnce();
	});

	it("uses the document navigation entry if history changed before hydration", () => {
		navigate(article);
		render();
		expect(reload).toHaveBeenCalledOnce();
	});

	it("does not reload a programmatic product-to-product transition", () => {
		render();
		navigate("/settings/general");
		render();
		expect(reload).not.toHaveBeenCalled();
	});

	it("captures history crossing before router restore and destroys frames before reload", () => {
		navigate(article);
		navigationName = current.href;
		render();
		frames = [frameFixture()];
		navigate("/create");
		const event = { stopImmediatePropagation: vi.fn() };
		windowSurface.invoke("popstate", event);
		expect(windowSurface.listeners.get("popstate")?.[0]?.capture).toBe(true);
		expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
		expect(trace.at(-1)).toBe("reload");
		expect(frames[0]?.removed).toBe(true);
	});

	it("retains same-document hashes and ordinary product history", () => {
		render();
		navigate("/create#editor");
		const event = { stopImmediatePropagation: vi.fn() };
		windowSurface.invoke("popstate", event);
		expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
		navigate("/pricing");
		windowSurface.invoke("popstate", event);
		expect(reload).not.toHaveBeenCalled();
	});

	it("removes frames before BFCache freeze and again on persisted restoration", () => {
		navigate(article);
		navigationName = current.href;
		render();
		frames = [frameFixture()];
		windowSurface.invoke("pagehide", {});
		expect(frames[0]?.removed).toBe(true);
		frames = [frameFixture()];
		windowSurface.invoke("pageshow", { persisted: true });
		expect(frames[0]?.removed).toBe(true);
		expect(reload).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});

	it("cleans up every navigation listener when the helper unmounts", () => {
		render();
		for (const slot of runtime.slots) slot.cleanup?.();
		expect(documentSurface.listeners.get("click")).toEqual([]);
		for (const type of ["popstate", "pagehide", "pageshow"])
			expect(windowSurface.listeners.get(type)).toEqual([]);
	});
});
