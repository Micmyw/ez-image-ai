import { QueryClient } from "@tanstack/react-query";
import React, { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Slot = {
	current?: unknown;
	value?: unknown;
	deps?: unknown[];
	cleanup?: () => void;
	status?: "idle" | "pending" | "success" | "error";
	error?: unknown;
};
type Element = ReactElement<Record<string, any>>;
const state = vi.hoisted(() => ({
	ownerId: "owner-a" as string | null,
	organization: null as { id: string; name: string } | null,
	client: null as unknown as QueryClient,
	view: "workspace",
	cursor: 0,
	slots: {} as Record<string, Slot[]>,
	rootKey: null as string | null,
	queries: [] as { queryKey: unknown[]; enabled?: boolean }[],
	create: vi.fn(),
	reply: vi.fn(),
	listRefetch: vi.fn(),
	detailRefetch: vi.fn(),
	reset: vi.fn(),
}));

function slot(initial: Slot = {}) {
	const slots = (state.slots[state.view] ??= []);
	return (slots[state.cursor++] ??= initial);
}

vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useRef: (value: unknown) => slot({ current: value }),
	useState: (value: unknown) => {
		const item = slot({ value });
		return [
			item.value,
			(next: unknown) => {
				item.value = next;
			},
		];
	},
	useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
		const item = slot();
		if (item.deps && deps.every((value, index) => item.deps?.[index] === value)) return;
		item.cleanup?.();
		item.deps = deps;
		item.cleanup = effect() || undefined;
	},
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: state.ownerId ? { id: state.ownerId, isAnonymous: false } : null }),
}));
vi.mock("@organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ activeOrganization: state.organization }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { support: { create: state.create, reply: state.reply } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		support: {
			list: {
				key: () => ["support", "list"],
				queryOptions: (options: unknown) => options,
			},
			get: {
				key: () => ["support", "get"],
				queryOptions: (options: unknown) => options,
			},
		},
	},
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useQueryClient: () => state.client,
	useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
		state.queries.push(options);
		const list = options.queryKey[1] === "list";
		const data =
			state.client.getQueryData(options.queryKey) ??
			(list ? { items: [], total: 0, page: 1, pageSize: 20 } : undefined);
		return {
			data,
			isPending: !data,
			isFetching: false,
			error: undefined,
			refetch: list ? state.listRefetch : state.detailRefetch,
		};
	},
	useMutation: ({ mutationFn }: { mutationFn: (input: unknown) => Promise<unknown> }) => {
		const item = slot({ status: "idle" });
		return {
			isPending: item.status === "pending",
			isSuccess: item.status === "success",
			error: item.error,
			mutateAsync: async (input: unknown) => {
				item.status = "pending";
				item.error = undefined;
				try {
					const result = await mutationFn(input);
					item.status = "success";
					return result;
				} catch (error) {
					item.status = "error";
					item.error = error;
					throw error;
				}
			},
		};
	},
}));
vi.mock("react-hook-form", () => ({
	useForm: () => ({
		register: (name: string) => ({ name }),
		handleSubmit: (callback: (input: any) => Promise<void>) => callback,
		reset: state.reset,
		formState: { errors: {} },
	}),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@repo/ui/components/button", () => ({ Button: "button" }));
vi.mock("@repo/ui/components/card", () => ({ Card: "section" }));
vi.mock("@repo/ui/components/input", () => ({ Input: "input" }));
vi.mock("@repo/ui/components/textarea", () => ({ Textarea: "textarea" }));

import { SupportWorkspace, TicketMessages } from "./SupportWorkspace";

function cleanup() {
	for (const slots of Object.values(state.slots)) {
		for (const item of slots) item.cleanup?.();
	}
}

function renderWorkspace(): Element {
	const entry = SupportWorkspace()!;
	if (state.rootKey !== entry.key) {
		cleanup();
		state.slots = {};
		state.rootKey = entry.key;
	}
	state.view = "workspace";
	state.cursor = 0;
	return (entry.type as (props: typeof entry.props) => Element)(entry.props);
}

function find(node: ReactNode, predicate: (element: Element) => boolean): Element {
	if (React.isValidElement(node)) {
		const element = node as Element;
		if (predicate(element)) return element;
		for (const child of React.Children.toArray(element.props.children)) {
			try {
				return find(child, predicate);
			} catch {}
		}
	}
	throw new Error("Element not found");
}

function createForm(tree = renderWorkspace()) {
	return find(tree, (element) => element.type === "form");
}

function renderReply(tree = renderWorkspace()) {
	const entry = find(tree, (element) => typeof element.props.onConfirmed === "function");
	state.view = `reply:${entry.props.ticketId}`;
	state.cursor = 0;
	return (entry.type as (props: typeof entry.props) => Element)(entry.props);
}

function ticket(overrides: Record<string, unknown> = {}) {
	return {
		id: "ticket-a",
		subject: "Question",
		status: "OPEN",
		createdByUserId: "owner-a",
		organizationId: null,
		createdAt: "2026-10-20T01:00:00.000Z",
		updatedAt: "2026-10-20T01:00:00.000Z",
		messages: [
			{
				id: "message-a",
				body: "Hello",
				authorType: "CUSTOMER",
				createdAt: "2026-10-20T01:00:00.000Z",
			},
		],
		...overrides,
	};
}

const input = { subject: "Question", body: "Hello" };
beforeEach(() => {
	vi.clearAllMocks();
	state.client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	state.ownerId = "owner-a";
	state.organization = null;
	state.rootKey = null;
	state.slots = {};
	state.queries = [];
	state.create.mockReset().mockResolvedValue({ ticket: ticket(), created: true });
	state.reply.mockReset().mockResolvedValue({ ticket: ticket(), created: true });
	state.listRefetch.mockReset().mockResolvedValue({});
	state.detailRefetch.mockReset().mockResolvedValue({});
});
afterEach(() => {
	cleanup();
	state.client.clear();
	vi.restoreAllMocks();
});

describe("support confirmation and scope", () => {
	it("shows the confirmed ticket without waiting for a list refresh or detail GET", async () => {
		vi.spyOn(state.client, "invalidateQueries").mockReturnValue(new Promise(() => {}));
		await createForm().props.onSubmit(input);
		const tree = renderWorkspace();
		expect(find(tree, (element) => element.type === TicketMessages).props.ticket).toEqual(ticket());
		expect(state.listRefetch).not.toHaveBeenCalled();
		expect(state.detailRefetch).not.toHaveBeenCalled();
		expect(state.create).toHaveBeenCalledOnce();
		expect(state.create).toHaveBeenCalledWith({ ...input, requestKey: expect.any(String) });
	});

	it("does not turn a list refresh failure into an uncertain submission", async () => {
		vi.spyOn(state.client, "invalidateQueries").mockRejectedValue(new Error("List unavailable"));
		await createForm().props.onSubmit(input);
		const tree = renderWorkspace();
		expect(find(tree, (element) => element.type === TicketMessages).props.ticket.id).toBe(
			"ticket-a",
		);
		expect(find(tree, (element) => element.type === "fieldset").props.disabled).toBe(false);
	});

	it("publishes the confirmed reply and cancels a slower stale detail read", async () => {
		await createForm().props.onSubmit(input);
		renderWorkspace();
		const detailKey = state.queries.at(-1)!.queryKey;
		let resolveStale!: (value: unknown) => void;
		const stale = state.client
			.fetchQuery({
				queryKey: detailKey,
				queryFn: () =>
					new Promise((resolve) => {
						resolveStale = resolve;
					}),
			})
			.catch(() => undefined);
		const updated = ticket({
			messages: [
				...ticket().messages,
				{
					id: "message-b",
					body: "Reply",
					authorType: "CUSTOMER",
					createdAt: "2026-10-20T01:01:00.000Z",
				},
			],
		});
		state.reply.mockResolvedValue({ ticket: updated, created: true });
		await renderReply().props.onSubmit({ body: "Reply" });
		resolveStale(ticket());
		await stale;
		const tree = renderWorkspace();
		expect(find(tree, (element) => element.type === TicketMessages).props.ticket).toEqual(updated);
		expect(state.detailRefetch).not.toHaveBeenCalled();
		expect(state.listRefetch).not.toHaveBeenCalled();
	});

	it("preserves a newer conversation already loaded before the confirmed response arrives", async () => {
		await createForm().props.onSubmit(input);
		renderWorkspace();
		const detailKey = state.queries.at(-1)!.queryKey;
		let resolve!: (value: unknown) => void;
		state.reply.mockReturnValue(
			new Promise((resolvePromise) => {
				resolve = resolvePromise;
			}),
		);
		const pending = renderReply().props.onSubmit({ body: "Reply" });
		const newest = ticket({
			subject: "Newer conversation",
			updatedAt: "2026-10-20T01:02:00.000Z",
		});
		state.client.setQueryData(detailKey, newest);
		resolve({ ticket: ticket({ updatedAt: "2026-10-20T01:01:00.000Z" }), created: true });
		await pending;
		expect(state.client.getQueryData(detailKey)).toEqual(newest);
	});

	it("coalesces rapid submissions and keeps an unknown outcome locked before another render", async () => {
		let reject!: (reason: Error) => void;
		state.create.mockReturnValue(
			new Promise((_resolve, rejectPromise) => {
				reject = rejectPromise;
			}),
		);
		const form = createForm();
		const first = form.props.onSubmit(input);
		await form.props.onSubmit(input);
		expect(state.create).toHaveBeenCalledOnce();
		reject(new Error("Response lost"));
		await first;
		await form.props.onSubmit(input);
		expect(state.create).toHaveBeenCalledOnce();
		expect(find(renderWorkspace(), (element) => element.type === "fieldset").props.disabled).toBe(
			true,
		);
	});

	it("does not publish an old owner's delayed response after account switching", async () => {
		let resolve!: (value: unknown) => void;
		state.create.mockReturnValue(
			new Promise((resolvePromise) => {
				resolve = resolvePromise;
			}),
		);
		const pending = createForm().props.onSubmit(input);
		state.ownerId = "owner-b";
		renderWorkspace();
		resolve({ ticket: ticket(), created: true });
		await pending;
		expect(state.client.getQueryCache().getAll()).toHaveLength(0);
		expect(state.queries.at(-1)?.queryKey).toContainEqual({
			ownerId: "owner-b",
			organizationId: null,
			ticketId: "",
		});
	});

	it("does not publish a reply into a different organization scope", async () => {
		state.organization = { id: "org-a", name: "Organization A" };
		find(renderWorkspace(), (element) => element.props.type === "checkbox").props.onChange({
			target: { checked: true },
		});
		const original = ticket({ organizationId: "org-a" });
		state.create.mockResolvedValue({ ticket: original, created: true });
		await createForm().props.onSubmit(input);
		renderWorkspace();
		const oldKey = state.queries.at(-1)!.queryKey;
		let resolve!: (value: unknown) => void;
		state.reply.mockReturnValue(
			new Promise((resolvePromise) => {
				resolve = resolvePromise;
			}),
		);
		const pending = renderReply().props.onSubmit({ body: "Reply" });
		find(renderWorkspace(), (element) => element.props.type === "checkbox").props.onChange({
			target: { checked: false },
		});
		renderWorkspace();
		resolve({ ticket: ticket({ organizationId: "org-a", subject: "Changed" }), created: true });
		await pending;
		expect(state.client.getQueryData(oldKey)).toEqual(original);
		expect(state.queries.at(-1)?.queryKey).toContainEqual({
			ownerId: "owner-a",
			organizationId: null,
			ticketId: "",
		});
	});

	it("refreshes the selected detail and list in parallel", async () => {
		await createForm().props.onSubmit(input);
		const entry = find(
			renderWorkspace(),
			(element) => typeof element.props.onConfirmed === "function",
		);
		let resolve!: () => void;
		state.detailRefetch.mockReturnValue(
			new Promise<void>((resolvePromise) => {
				resolve = resolvePromise;
			}),
		);
		const refresh = entry.props.refresh();
		expect(state.detailRefetch).toHaveBeenCalledOnce();
		expect(state.listRefetch).toHaveBeenCalledOnce();
		resolve();
		await refresh;
	});

	it("does not render support queries for a signed-out visitor", () => {
		state.ownerId = null;
		expect(SupportWorkspace()).toBeNull();
		expect(state.queries).toHaveLength(0);
	});
});
