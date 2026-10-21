import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../../../packages/i18n/translations/en/shared.json";

const hooks = vi.hoisted(() => ({
	cursor: 0,
	values: [] as unknown[],
	effects: [] as (() => void)[],
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useEffect: (effect: () => void) => hooks.effects.push(effect),
	useState: <T,>(initial: T) => {
		const index = hooks.cursor++;
		if (!(index in hooks.values)) hooks.values[index] = initial;
		return [
			hooks.values[index] as T,
			(next: T) => {
				hooks.values[index] = next;
			},
		] as const;
	},
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => en.feedback[key as keyof typeof en.feedback],
}));

import { FeedbackButton, feedbackDialogResource } from "./FeedbackButton";
import { FeedbackRewardEntry } from "./FeedbackRewardEntry";

const dismissalKey = "ezpic:feedback-reward-entry:dismissed:v1";

function render(supportEmail: string | undefined = "help@configured.test") {
	hooks.cursor = 0;
	hooks.effects = [];
	return FeedbackRewardEntry({ supportEmail });
}

function mount(supportEmail?: string) {
	hooks.values = [];
	render(supportEmail);
	for (const effect of hooks.effects) effect();
	return render(supportEmail);
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!isValidElement<Record<string, unknown>>(node)) return [];
	return [node, ...elements(node.props.children as ReactNode)];
}

function close(tree: ReactNode) {
	const button = elements(tree).find(
		(element) => element.props["aria-label"] === "Dismiss feedback rewards",
	);
	expect(button?.type).toBe("button");
	expect(button?.props.type).toBe("button");
	(button!.props.onClick as () => void)();
}

describe("feedback reward entry", () => {
	let storage: Map<string, string>;
	beforeEach(() => {
		hooks.values = [];
		storage = new Map();
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
			},
		});
		vi.spyOn(feedbackDialogResource, "load");
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("shows a reward trigger with a separate, named close button after checking this visit", () => {
		const tree = mount();
		expect(tree?.props["data-test"]).toBe("feedback-reward-entry");
		const trigger = elements(tree).find((element) => element.type === FeedbackButton);
		expect(trigger?.props).toMatchObject({
			variant: "reward",
			supportEmail: "help@configured.test",
		});
		expect(elements(tree).filter((element) => element.type === "button")).toHaveLength(1);
		expect(renderToStaticMarkup(tree)).toContain('aria-label="Dismiss feedback rewards"');
		expect(feedbackDialogResource.load).not.toHaveBeenCalled();
	});

	it("dismisses without opening feedback and stays hidden after navigation remounts the entry", () => {
		close(mount());
		expect(render()).toBeNull();
		expect(storage.get(dismissalKey)).toBe("1");
		expect(mount()).toBeNull();
		expect(feedbackDialogResource.load).not.toHaveBeenCalled();
	});

	it("does not redisplay a dismissed entry before session storage has been checked", () => {
		storage.set(dismissalKey, "1");
		expect(render()).toBeNull();
		expect(mount()).toBeNull();
	});

	it("can still be dismissed when browser session storage is unavailable", () => {
		vi.stubGlobal("window", {
			get sessionStorage() {
				throw new Error("Storage unavailable");
			},
		});
		const tree = mount();
		expect(tree).not.toBeNull();
		expect(() => close(tree)).not.toThrow();
		expect(render()).toBeNull();
		expect(mount()).toBeNull();
		expect(feedbackDialogResource.load).not.toHaveBeenCalled();
	});

	it("does not offer feedback without a configured support email", () => {
		expect(FeedbackRewardEntry({})).toBeNull();
		expect(mount("")).toBeNull();
	});
});
