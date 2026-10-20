import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	cursor: 0,
	refCursor: 0,
	values: [] as unknown[],
	refs: [] as { current: unknown }[],
	effects: [] as (() => void | (() => void))[],
	messages: {} as Record<string, Record<string, string>>,
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useId: () => "feedback-load-status",
	useCallback: <T,>(callback: T) => callback,
	useEffect: (effect: () => void | (() => void)) => {
		hooks.effects.push(effect);
	},
	useRef: <T,>(initial: T) => {
		const index = hooks.refCursor++;
		hooks.refs[index] ??= { current: initial };
		return hooks.refs[index] as { current: T };
	},
	useState: <T,>(initial: T) => {
		const index = hooks.cursor++;
		if (!(index in hooks.values)) hooks.values[index] = initial;
		return [
			hooks.values[index] as T,
			(next: T | ((current: T) => T)) => {
				hooks.values[index] =
					typeof next === "function" ? (next as (current: T) => T)(hooks.values[index] as T) : next;
			},
		] as const;
	},
}));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => hooks.messages[namespace]?.[key] ?? key,
}));

import { FeedbackButton, feedbackDialogResource } from "./FeedbackButton";

type ButtonProps = ComponentProps<typeof FeedbackButton>;
type DialogComponent = NonNullable<ReturnType<typeof feedbackDialogResource.read>>;
type DialogProps = ComponentProps<DialogComponent>;
const FakeDialog = ({ open }: DialogProps) => <form hidden={!open}>Feedback form</form>;

function render(props: Partial<ButtonProps> = {}) {
	hooks.cursor = 0;
	hooks.refCursor = 0;
	hooks.effects = [];
	return FeedbackButton({ supportEmail: "help@configured.test", ...props });
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!isValidElement<Record<string, unknown>>(node)) return [];
	return [node, ...elements(node.props.children as ReactNode)];
}

function trigger(tree: ReactNode) {
	const element = elements(tree).find((item) => item.props["aria-haspopup"] === "dialog");
	if (!element) throw new Error("Missing feedback trigger");
	return element as ReactElement<{
		onClick: () => void;
		onFocus: () => void;
		onPointerEnter: () => void;
	}>;
}

function button(tree: ReactNode, label: string) {
	const element = elements(tree).find(
		(item) => item.type === "button" && item.props.children === label,
	);
	if (!element) throw new Error(`Missing ${label} button`);
	return element as ReactElement<{ onClick: () => void }>;
}

function dialog(tree: ReactNode) {
	return elements(tree).find((item) => item.type === FakeDialog) as
		| ReactElement<DialogProps>
		| undefined;
}

describe("feedback button loading and retry", () => {
	beforeEach(() => {
		hooks.cursor = 0;
		hooks.refCursor = 0;
		hooks.values = [];
		hooks.refs = [];
		hooks.effects = [];
		hooks.messages = {
			feedback: { entry: "Feedback", footer: "Feedback", report: "Report a bug" },
			studio: { loading: "Loading", error: "Load failed", retry: "Retry", closePanel: "Close" },
		};
		vi.useFakeTimers();
		vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
		vi.spyOn(feedbackDialogResource, "read").mockReturnValue(null);
		vi.spyOn(feedbackDialogResource, "load");
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("preloads from pointer or keyboard intent without showing or mounting a form", async () => {
		const load = vi.mocked(feedbackDialogResource.load).mockResolvedValue(FakeDialog);
		const tree = render();
		expect(load).not.toHaveBeenCalled();
		trigger(tree).props.onPointerEnter();
		trigger(tree).props.onFocus();
		await Promise.resolve();
		const markup = renderToStaticMarkup(render());
		expect(load).toHaveBeenCalledTimes(2);
		expect(markup).not.toContain('role="status"');
		expect(dialog(render())).toBeUndefined();
	});

	it.each(["en", "de", "es", "fr"] as const)(
		"shows current %s loading and close labels immediately after a click",
		async (locale) => {
			const full = await getUnifiedMessagesForLocale(locale);
			hooks.messages = {
				feedback: { entry: full.feedback.entry, report: full.feedback.report },
				studio: {
					loading: full.studio.loading,
					error: full.studio.error,
					retry: full.studio.retry,
					closePanel: full.studio.closePanel,
				},
			};
			const request = Promise.withResolvers<DialogComponent>();
			vi.mocked(feedbackDialogResource.load).mockReturnValue(request.promise);
			trigger(render()).props.onClick();
			const markup = renderToStaticMarkup(render());
			expect(markup).toContain(full.studio.loading);
			expect(markup).toContain(full.studio.closePanel);
			expect(markup).toContain('role="status"');
			expect(markup).toContain('aria-busy="true"');
			expect(dialog(render())).toBeUndefined();
			button(render(), full.studio.closePanel).props.onClick();
			request.resolve(FakeDialog);
			await Promise.resolve();
		},
	);

	it("cancels pending animation and ignores a late download instead of opening the form", async () => {
		const request = Promise.withResolvers<DialogComponent>();
		const load = vi.mocked(feedbackDialogResource.load).mockReturnValue(request.promise);
		trigger(render()).props.onClick();
		expect(renderToStaticMarkup(render())).toContain("feedback-burst");
		button(render(), "Close").props.onClick();
		vi.advanceTimersByTime(500);
		request.resolve(FakeDialog);
		await Promise.resolve();
		const tree = render();
		expect(dialog(tree)).toBeUndefined();
		expect(renderToStaticMarkup(tree)).not.toContain('role="status"');
		expect(renderToStaticMarkup(tree)).toContain('aria-expanded="false"');
		// Focus restoration after cancellation must not issue an automatic retry.
		trigger(tree).props.onFocus();
		expect(load).toHaveBeenCalledOnce();
	});

	it("retries an explicit failure and opens the loaded form without an automatic retry loop", async () => {
		const load = vi
			.mocked(feedbackDialogResource.load)
			.mockRejectedValueOnce(new Error("Network unavailable"))
			.mockResolvedValueOnce(FakeDialog);
		trigger(render({ variant: "report" })).props.onClick();
		await Promise.resolve();
		const failed = render({ variant: "report" });
		expect(renderToStaticMarkup(failed)).toContain('role="alert"');
		expect(renderToStaticMarkup(failed)).toContain("Load failed");
		trigger(failed).props.onFocus();
		trigger(failed).props.onPointerEnter();
		expect(load).toHaveBeenCalledOnce();
		button(failed, "Retry").props.onClick();
		await Promise.resolve();
		expect(dialog(render({ variant: "report" }))?.props.open).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("keeps the loaded form mounted across animated close and reopen", () => {
		vi.mocked(feedbackDialogResource.read).mockReturnValue(FakeDialog);
		trigger(render()).props.onClick();
		expect(dialog(render())?.props.open).toBe(false);
		expect(renderToStaticMarkup(render())).toContain("feedback-burst");
		vi.advanceTimersByTime(400);
		const opened = dialog(render());
		expect(opened?.props.open).toBe(true);
		opened?.props.onOpenChange(false);
		const closed = dialog(render());
		expect(closed?.type).toBe(opened?.type);
		expect(closed?.key).toBe(opened?.key);
		expect(closed?.props.open).toBe(false);
		trigger(render()).props.onClick();
		vi.advanceTimersByTime(400);
		const reopened = dialog(render());
		expect(reopened?.type).toBe(opened?.type);
		expect(reopened?.key).toBe(opened?.key);
		expect(reopened?.props.open).toBe(true);
		expect(feedbackDialogResource.load).not.toHaveBeenCalled();
	});

	it("opens immediately without a gift burst for reduced motion", () => {
		vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
		vi.mocked(feedbackDialogResource.read).mockReturnValue(FakeDialog);
		trigger(render()).props.onClick();
		const tree = render();
		expect(dialog(tree)?.props.open).toBe(true);
		expect(renderToStaticMarkup(tree)).not.toContain("feedback-burst");
	});

	it("allows Escape to dismiss loading and removes its keyboard listener", () => {
		const addEventListener = vi.fn();
		const removeEventListener = vi.fn();
		vi.stubGlobal("document", { addEventListener, removeEventListener });
		vi.mocked(feedbackDialogResource.load).mockReturnValue(new Promise(() => {}));
		trigger(render({ variant: "report" })).props.onClick();
		render({ variant: "report" });
		const cleanup = hooks.effects[1]?.();
		const escape = addEventListener.mock.calls[0]?.[1] as (event: {
			key: string;
			defaultPrevented: boolean;
			preventDefault: () => void;
		}) => void;
		const preventDefault = vi.fn();
		escape({ key: "Escape", defaultPrevented: false, preventDefault });
		expect(preventDefault).toHaveBeenCalledOnce();
		expect(renderToStaticMarkup(render({ variant: "report" }))).not.toContain('role="status"');
		if (typeof cleanup === "function") cleanup();
		expect(removeEventListener).toHaveBeenCalledWith("keydown", escape);
	});
});
