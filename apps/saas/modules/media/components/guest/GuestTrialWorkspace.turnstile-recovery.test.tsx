import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
	process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY = "turnstile-site-key";
	return {
		cursor: 0,
		initialized: [] as boolean[],
		refs: [] as Array<{ current: unknown }>,
		refCursor: 0,
		states: [] as unknown[],
		submit: vi.fn(() => Promise.resolve()),
		turnstile: vi.fn(() => null),
	};
});

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useEffect: vi.fn(),
		useRef: <T,>(initial: T) => {
			const index = testState.refCursor++;
			testState.refs[index] ??= { current: initial };
			return testState.refs[index] as { current: T };
		},
		useState: <T,>(initial: T | (() => T)) => {
			const index = testState.cursor++;
			if (!testState.initialized[index]) {
				testState.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
				testState.initialized[index] = true;
			}
			const setState = (next: T | ((current: T) => T)) => {
				const current = testState.states[index] as T;
				testState.states[index] =
					typeof next === "function" ? (next as (current: T) => T)(current) : next;
			};
			return [testState.states[index] as T, setState] as const;
		},
	};
});
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@repo/ui/components/turnstile", () => ({ Turnstile: testState.turnstile }));
vi.mock("@repo/ui/components/alert", () => ({ Alert: () => null, AlertDescription: () => null }));
vi.mock("@repo/ui/components/button", () => ({ Button: vi.fn(() => null) }));
vi.mock("@repo/ui/components/textarea", () => ({ Textarea: vi.fn(() => null) }));
vi.mock("../../hooks/use-guest-trial", () => ({
	useGuestTrial: () => ({
		view: { state: "preparingSession" },
		draft: { sourceAssetId: "source-1", prompt: "Keep the subject" },
		prompt: "Keep the subject",
		setPrompt: vi.fn(),
		canSubmit: true,
		isSubmitting: false,
		resultUrl: null,
		actions: {
			submit: testState.submit,
			viewStatus: vi.fn(),
			viewResult: vi.fn(),
			download: vi.fn(),
			beginLink: vi.fn(),
		},
	}),
}));
vi.mock("./GuestShell", () => ({ useGuestShellLinking: () => ({ setLinkHandler: vi.fn() }) }));
vi.mock("./GuestStatusPanel", () => ({ GuestStatusPanel: () => null }));
vi.mock("./GuestResultCard", () => ({ GuestResultCard: () => null }));
vi.mock("./GuestConversionActions", () => ({ GuestConversionActions: () => null }));

import { Button } from "@repo/ui/components/button";
import { Turnstile } from "@repo/ui/components/turnstile";

import { GuestTrialWorkspace } from "./GuestTrialWorkspace";

describe("GuestTrialWorkspace Turnstile recovery", () => {
	beforeEach(() => {
		testState.cursor = 0;
		testState.initialized = [];
		testState.refs = [];
		testState.refCursor = 0;
		testState.states = [];
		vi.clearAllMocks();
	});

	it("remounts every consumed challenge and accepts a fresh token for retry", async () => {
		let tree = renderWorkspace();
		callbackProp<(token: string) => void>(
			findElement(tree, (element) => element.type === Turnstile),
			"onToken",
		)?.("token-one");
		tree = renderWorkspace();
		callbackProp<(event: { preventDefault: () => void }) => void>(
			findElement(tree, (element) => element.type === "form"),
			"onSubmit",
		)?.({ preventDefault: vi.fn() });
		await vi.waitFor(() => expect(testState.submit).toHaveBeenCalledWith("token-one"));

		tree = renderWorkspace();
		expect(findElement(tree, (element) => element.type === Turnstile)?.props.resetKey).toBe(1);
		expect(findElement(tree, (element) => element.type === Button)?.props.disabled).toBe(true);
		callbackProp<(token: string) => void>(
			findElement(tree, (element) => element.type === Turnstile),
			"onToken",
		)?.("token-two");
		tree = renderWorkspace();
		expect(findElement(tree, (element) => element.type === Button)?.props.disabled).toBe(false);
		callbackProp<(event: { preventDefault: () => void }) => void>(
			findElement(tree, (element) => element.type === "form"),
			"onSubmit",
		)?.({ preventDefault: vi.fn() });

		await vi.waitFor(() => expect(testState.submit).toHaveBeenLastCalledWith("token-two"));
		expect(testState.submit).toHaveBeenCalledTimes(2);
	});

	it("surfaces a widget error and remounts the failed challenge", () => {
		let tree = renderWorkspace();
		callbackProp<() => void>(
			findElement(tree, (element) => element.type === Turnstile),
			"onError",
		)?.();
		tree = renderWorkspace();

		expect(findElement(tree, (element) => element.type === Turnstile)?.props.resetKey).toBe(1);
		expect(visibleText(tree)).toContain("retryChallenge");
	});
});

function renderWorkspace() {
	testState.cursor = 0;
	testState.refCursor = 0;
	return GuestTrialWorkspace({});
}

function findElement(
	node: ReactNode,
	predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (predicate(node)) return node;
	return React.Children.toArray(node.props.children as ReactNode)
		.map((child) => findElement(child, predicate))
		.find(Boolean);
}

function visibleText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (!isValidElement<Record<string, unknown>>(node)) return "";
	return React.Children.toArray(node.props.children as ReactNode)
		.map(visibleText)
		.join(" ");
}

function callbackProp<T extends (...arguments_: never[]) => unknown>(
	element: ReactElement<Record<string, unknown>> | undefined,
	name: string,
): T | undefined {
	const value = element?.props[name];
	return typeof value === "function" ? (value as T) : undefined;
}
