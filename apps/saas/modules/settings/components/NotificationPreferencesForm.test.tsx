import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	role: "member",
	data: undefined as { disabled: Array<{ type: string; target: string }> } | undefined,
	pending: true,
	failed: false,
	fetching: true,
	updating: false,
	retry: vi.fn(),
	mutate: vi.fn(),
	invalidate: vi.fn(),
	onSuccess: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useMemo: <T,>(factory: () => T) => factory(),
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "customer", role: state.role } }),
}));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock("@repo/ui", () => ({ Button: "button", Card: "card", Switch: "switch" }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		notifications: {
			getPreferences: {
				queryOptions: () => ({ queryKey: ["preferences"] }),
				queryKey: () => ["preferences"],
			},
			updatePreference: { mutationOptions: (options: unknown) => options },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: state.data,
		isPending: state.pending,
		isError: state.failed,
		isFetching: state.fetching,
		refetch: state.retry,
	}),
	useMutation: (options: { onSuccess: () => Promise<void> }) => {
		state.onSuccess = options.onSuccess;
		return { mutate: state.mutate, isPending: state.updating };
	},
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));

import { NotificationPreferencesForm } from "./NotificationPreferencesForm";

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

function switches(node: ReactNode) {
	return elements(node).filter((element) => element.type === "switch");
}

describe("notification preferences read feedback", () => {
	beforeEach(() => {
		state.role = "member";
		state.data = undefined;
		state.pending = true;
		state.failed = false;
		state.fetching = true;
		state.updating = false;
		state.onSuccess = undefined;
		state.retry.mockReset().mockResolvedValue({});
		state.mutate.mockReset();
		state.invalidate.mockReset().mockResolvedValue(undefined);
	});

	it("announces loading without exposing default enabled switches", () => {
		const node = NotificationPreferencesForm();
		expect(node.props["aria-busy"]).toBe(true);
		expect(content(node)).toContain("studio.loading");
		expect(elements(node).find((element) => element.type === "output")?.props["aria-live"]).toBe(
			"polite",
		);
		expect(switches(node)).toHaveLength(0);
		expect(state.mutate).not.toHaveBeenCalled();
	});

	it.each(["read-error", "missing-data", "cached-data-error"] as const)(
		"blocks editing after %s and provides a busy retry",
		(failure) => {
			state.pending = false;
			state.fetching = false;
			state.failed = failure !== "missing-data";
			if (failure === "cached-data-error") state.data = { disabled: [] };
			const node = NotificationPreferencesForm();
			expect(content(node)).toContain("studio.error");
			expect(elements(node).some((element) => element.props.role === "alert")).toBe(true);
			expect(switches(node)).toHaveLength(0);
			const retry = elements(node).find(
				(element) => element.type === "button" && element.props.children === "studio.retry",
			);
			expect(retry).toBeDefined();
			retry?.props.onClick();
			expect(state.retry).toHaveBeenCalledOnce();
			expect(state.mutate).not.toHaveBeenCalled();

			state.fetching = true;
			const retrying = NotificationPreferencesForm();
			expect(retrying.props["aria-busy"]).toBe(true);
			expect(
				elements(retrying).find((element) => element.props.children === "studio.retry")?.props
					.loading,
			).toBe(true);
			expect(switches(retrying)).toHaveLength(0);
		},
	);

	it("uses fetched preferences and preserves the update and invalidation contract", async () => {
		state.pending = false;
		state.fetching = false;
		state.data = { disabled: [{ type: "APP_UPDATE", target: "EMAIL" }] };
		const node = NotificationPreferencesForm();
		const controls = switches(node);
		expect(controls).toHaveLength(2);
		expect(content(node)).not.toContain("MODERATION_ALERT");
		expect(
			controls.find((element) => element.props["aria-label"] === "APP_UPDATE in-app")?.props
				.checked,
		).toBe(true);
		const email = controls.find((element) => element.props["aria-label"] === "APP_UPDATE email");
		expect(email?.props.checked).toBe(false);
		email?.props.onCheckedChange(true);
		expect(state.mutate).toHaveBeenCalledWith({
			type: "APP_UPDATE",
			target: "EMAIL",
			disabled: false,
		});
		await state.onSuccess?.();
		expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["preferences"] });
	});

	it("keeps confirmed preferences during refresh and blocks changes while saving", () => {
		state.pending = false;
		state.data = { disabled: [] };
		const refreshing = NotificationPreferencesForm();
		expect(content(refreshing)).not.toContain("studio.loading");
		expect(switches(refreshing)).toHaveLength(2);
		expect(switches(refreshing).every((element) => element.props.checked)).toBe(true);

		state.updating = true;
		const saving = switches(NotificationPreferencesForm());
		expect(saving.every((element) => element.props.disabled)).toBe(true);
		saving[0]?.props.onCheckedChange(false);
		expect(state.mutate).not.toHaveBeenCalled();
	});

	it("retains the administrator-only in-app moderation preference", () => {
		state.role = "admin";
		state.pending = false;
		state.fetching = false;
		state.data = { disabled: [{ type: "MODERATION_ALERT", target: "IN_APP" }] };
		const controls = switches(NotificationPreferencesForm());
		expect(controls).toHaveLength(3);
		expect(
			controls.find((element) => element.props["aria-label"] === "MODERATION_ALERT in-app")?.props
				.checked,
		).toBe(false);
		expect(
			controls.some((element) => element.props["aria-label"] === "MODERATION_ALERT email"),
		).toBe(false);
	});
});
