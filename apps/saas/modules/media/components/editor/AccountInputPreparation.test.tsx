import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PollQueryOptions {
	queryKey: string[];
	queryFn: (input: { signal: AbortSignal }) => Promise<unknown>;
	enabled: boolean;
	refetchInterval: (query: {
		state: { data?: { status: string }; error?: unknown };
	}) => number | false;
}

const state = vi.hoisted(() => ({
	ownerId: "owner-1",
	cursor: 0,
	slots: [] as {
		current?: unknown;
		value?: unknown;
		deps?: unknown[];
		cleanup?: (() => void) | void;
	}[],
	query: {} as Record<string, unknown>,
	options: {} as PollQueryOptions,
	status: vi.fn(),
	refresh: vi.fn(),
	refetch: vi.fn(),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useRef: (current: unknown) => (state.slots[state.cursor++] ??= { current }),
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
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ loaded: true, user: { id: state.ownerId } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: state.refresh }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { getAccountInputCopyStatus: state.status } },
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: PollQueryOptions) => {
		state.options = options;
		return { ...state.query, refetch: state.refetch };
	},
}));

import { AccountInputPreparation } from "./AccountInputPreparation";

const initialStatus = { promotionId: "copy-1", status: "COPYING" as const };
function render(status: "COPYING" | "VERIFYING" | "READY" | "FAILED" | "EXPIRED" = "COPYING") {
	state.cursor = 0;
	return AccountInputPreparation({
		draftId: "draft-1",
		ownerId: "owner-1",
		initialStatus: { ...initialStatus, status },
	});
}
function button(element: ReactElement): ReactElement<{ onClick: () => Promise<void> }> {
	if (element.type === "button") return element as ReactElement<{ onClick: () => Promise<void> }>;
	for (const child of React.Children.toArray(
		(element.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return button(child);
		} catch {
			/* Try siblings. */
		}
	}
	throw new Error("recheck button missing");
}

describe("AccountInputPreparation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		state.ownerId = "owner-1";
		state.slots = [];
		state.query = { data: undefined, isError: false, isFetching: false };
		state.refetch.mockResolvedValue({ data: initialStatus });
	});
	afterEach(() => {
		for (const slot of state.slots) slot.cleanup?.();
		vi.useRealTimers();
	});
	it.each(["COPYING", "VERIFYING"] as const)(
		"shows %s without a generation form or prompt",
		(status) => {
			const markup = renderToStaticMarkup(render(status));
			expect(markup).toContain(status === "COPYING" ? "copying" : "verifying");
			expect(markup).toContain("saved");
			expect(markup).not.toContain("draftError=unavailable");
			expect(markup).not.toMatch(/<form|<textarea|sourceAssetId|objectKey/);
			expect(state.refresh).not.toHaveBeenCalled();
		},
	);
	it("polls only the draft with an owner-isolated cache and abort signal", async () => {
		render();
		state.status.mockResolvedValue(initialStatus);
		const signal = new AbortController().signal;
		await expect(state.options.queryFn({ signal })).resolves.toEqual(initialStatus);
		expect(state.status).toHaveBeenCalledWith({ draftId: "draft-1" }, { signal });
		expect(state.options.queryKey).toEqual(["media-account-input-copy", "owner-1", "draft-1"]);
		expect(state.options.refetchInterval({ state: { data: initialStatus } })).toBe(3000);
		expect(state.options.refetchInterval({ state: { data: { status: "VERIFYING" } } })).toBe(3000);
		for (const status of ["READY", "FAILED", "EXPIRED"]) {
			expect(state.options.refetchInterval({ state: { data: { status } } })).toBe(false);
		}
		expect(
			state.options.refetchInterval({ state: { data: initialStatus, error: new Error() } }),
		).toBe(false);
	});
	it("stops automatic checks at the foreground limit and lets the user recheck", async () => {
		render();
		vi.advanceTimersByTime(120_000);
		const element = render();
		expect(renderToStaticMarkup(element)).toContain("paused");
		expect(state.options.enabled).toBe(false);
		expect(state.options.refetchInterval({ state: { data: initialStatus } })).toBe(false);
		await button(element).props.onClick();
		expect(state.refetch).toHaveBeenCalledOnce();
		render();
		expect(state.options.enabled).toBe(true);
	});
	it.each(["FAILED", "EXPIRED"] as const)("keeps %s blocked with manual recheck", (status) => {
		const markup = renderToStaticMarkup(render(status));
		expect(markup).toContain(status === "FAILED" ? "failed" : "expired");
		expect(markup).toContain("recheck");
		expect(markup).toContain('href="/create?draftError=unavailable"');
		expect(state.options.enabled).toBe(false);
		expect(state.refresh).not.toHaveBeenCalled();
	});
	it("shows a safe connection error and never refreshes stale READY data", () => {
		state.query = {
			data: { ...initialStatus, status: "READY" },
			isError: true,
			error: new Error("private-key provider failure"),
		};
		const markup = renderToStaticMarkup(render());
		expect(markup).toContain("connectionError");
		expect(markup).not.toMatch(/private-key|provider failure/);
		expect(state.refresh).not.toHaveBeenCalled();
	});
	it("refreshes server recovery once after READY without submitting a generation", () => {
		state.query = { data: { ...initialStatus, status: "READY" }, isError: false };
		render();
		render();
		expect(state.refresh).toHaveBeenCalledOnce();
		expect(state.status).not.toHaveBeenCalled();
	});
	it("blocks cached preparation and prevents refresh after switching accounts", () => {
		state.ownerId = "owner-2";
		state.query = { data: { ...initialStatus, status: "READY" }, isError: false };
		expect(renderToStaticMarkup(render())).toContain("unavailable");
		expect(state.options.enabled).toBe(false);
		expect(state.refresh).not.toHaveBeenCalled();
	});
});
