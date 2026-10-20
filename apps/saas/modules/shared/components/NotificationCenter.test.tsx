import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	open: false,
	list: undefined as
		| Array<{
				id: string;
				type: string;
				data: { title: string };
				link: null;
				read: boolean;
				createdAt: string;
		  }>
		| undefined,
	pending: true,
	failed: false,
	fetching: false,
	query: vi.fn(),
	retry: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useEffect: vi.fn(),
	useState: () => [
		state.open,
		(open: boolean) => {
			state.open = open;
		},
	],
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "customer" } }),
}));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@repo/ui", () => ({
	Button: "button",
	Popover: "popover",
	PopoverContent: "popover-content",
	PopoverTrigger: "popover-trigger",
	cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		notifications: {
			unreadCount: {
				queryOptions: () => ({ queryKey: ["unread"] }),
				queryKey: () => ["unread"],
			},
			list: {
				queryOptions: () => ({ queryKey: ["list"] }),
				queryKey: () => ["list"],
			},
			markRead: { mutationOptions: (options: unknown) => options },
			markAllRead: { mutationOptions: (options: unknown) => options },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: { queryKey: string[] }) => {
		state.query(options);
		return options.queryKey[0] === "list"
			? {
					data: state.list,
					isPending: state.pending,
					isError: state.failed,
					isFetching: state.fetching,
					refetch: state.retry,
				}
			: { data: { count: 0 } };
	},
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { NotificationCenter } from "./NotificationCenter";

type Element = ReactElement<Record<string, any>>;

function elements(node: ReactNode): Element[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!isValidElement<Record<string, any>>(node)) return [];
	return [node, ...elements(node.props.children)];
}

function content(node: ReactNode): string {
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(content).join(" ");
	if (isValidElement<{ children?: ReactNode }>(node)) return content(node.props.children);
	return "";
}

describe("notification list feedback", () => {
	beforeEach(() => {
		state.open = false;
		state.list = undefined;
		state.pending = true;
		state.failed = false;
		state.fetching = false;
		state.query.mockReset();
		state.retry.mockReset().mockResolvedValue({});
	});

	it("keeps list requests behind opening and reports loading instead of an empty inbox", () => {
		const closed = NotificationCenter({});
		if (!closed) throw new Error("Notification center missing");
		expect(state.query).toHaveBeenCalledWith({ queryKey: ["list"], enabled: false });
		closed.props.onOpenChange(true);
		state.fetching = true;
		const opened = NotificationCenter({});
		expect(state.query).toHaveBeenLastCalledWith({ queryKey: ["list"], enabled: true });
		expect(content(opened)).toContain("studio.loading");
		expect(content(opened)).not.toContain("app.notifications.empty");
		expect(elements(opened).find((element) => element.type === "output")?.props["aria-live"]).toBe(
			"polite",
		);
	});

	it("shows a localized retry after failure and reports an empty inbox only after success", () => {
		state.open = true;
		state.pending = false;
		state.failed = true;
		const failed = NotificationCenter({});
		expect(content(failed)).toContain("studio.error");
		expect(content(failed)).not.toContain("app.notifications.empty");
		expect(elements(failed).some((element) => element.props.role === "alert")).toBe(true);
		const retry = elements(failed).find(
			(element) => element.type === "button" && element.props.children === "studio.retry",
		);
		expect(retry).toBeDefined();
		retry?.props.onClick();
		expect(state.retry).toHaveBeenCalledOnce();

		state.fetching = true;
		const retrying = NotificationCenter({});
		expect(
			elements(retrying).find((element) => element.props.children === "studio.retry")?.props
				.loading,
		).toBe(true);
		expect(content(retrying)).not.toContain("app.notifications.empty");

		state.failed = false;
		state.fetching = false;
		state.list = [];
		expect(content(NotificationCenter({}))).toContain("app.notifications.empty");
	});

	it("preserves fetched notifications during an ordinary background refresh", () => {
		state.open = true;
		state.pending = false;
		state.fetching = true;
		state.list = [
			{
				id: "notification-a",
				type: "WELCOME",
				data: { title: "Welcome, customer" },
				link: null,
				read: true,
				createdAt: "2026-10-20T00:00:00Z",
			},
		];
		const node = NotificationCenter({});
		expect(content(node)).toContain("Welcome, customer");
		expect(content(node)).not.toContain("studio.loading");
		expect(content(node)).not.toContain("app.notifications.empty");
	});
});
