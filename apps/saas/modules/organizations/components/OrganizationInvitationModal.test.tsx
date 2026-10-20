import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	cursor: 0,
	values: [] as unknown[],
	accept: vi.fn(),
	reject: vi.fn(),
	invalidate: vi.fn(),
	replace: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useState: <T,>(initial: T) => {
		const index = state.cursor++;
		if (!(index in state.values)) state.values[index] = initial;
		return [
			state.values[index] as T,
			(next: T) => {
				state.values[index] = next;
			},
		];
	},
}));
vi.mock("@repo/auth/client", () => ({
	authClient: {
		organization: {
			acceptInvitation: state.accept,
			rejectInvitation: state.reject,
		},
	},
}));
vi.mock("@organizations/components/OrganizationLogo", () => ({
	OrganizationLogo: "organization-logo",
}));
vi.mock("@organizations/lib/api", () => ({ organizationListQueryKey: ["organizations"] }));
vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ replace: state.replace }) }));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@repo/ui/components/button", () => ({ Button: "button" }));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: "alert",
	AlertDescription: "alert-description",
}));
vi.mock("lucide-react", () => ({ CheckIcon: "check-icon", XIcon: "x-icon" }));

import { OrganizationInvitationModal } from "./OrganizationInvitationModal";

type Element = ReactElement<Record<string, any>>;

function elements(node: ReactNode): Element[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!isValidElement<Record<string, any>>(node)) return [];
	return [node, ...elements(node.props.children)];
}

function render() {
	state.cursor = 0;
	return OrganizationInvitationModal({
		invitationId: "invitation-a",
		organizationName: "Customer team",
		organizationSlug: "customer-team",
	});
}

function buttons(node = render()) {
	return elements(node).filter((element) => element.type === "button");
}

function answerButton(answer: "accept" | "reject") {
	const label = `organizations.invitationModal.${answer === "accept" ? "accept" : "decline"}`;
	const button = buttons().find((element) =>
		(element.props.children as ReactNode[]).includes(label),
	);
	if (!button) throw new Error(`Missing ${answer} button`);
	return button;
}

function errorMessage(node = render()) {
	return elements(node).find((element) => element.type === "alert-description")?.props.children;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("organization invitation failure feedback", () => {
	beforeEach(() => {
		state.cursor = 0;
		state.values = [];
		state.accept.mockReset().mockResolvedValue({ error: null });
		state.reject.mockReset().mockResolvedValue({ error: null });
		state.invalidate.mockReset().mockResolvedValue(undefined);
		state.replace.mockReset();
	});

	it.each([
		{ answer: "accept", failure: "response" },
		{ answer: "accept", failure: "network" },
		{ answer: "reject", failure: "response" },
		{ answer: "reject", failure: "network" },
	] as const)("shows $answer $failure failures and allows retry", async ({ answer, failure }) => {
		const request = state[answer];
		if (failure === "response") {
			request.mockResolvedValueOnce({ error: { code: "INVITATION_FAILED" } });
		} else {
			request.mockRejectedValueOnce(new Error("Offline"));
		}
		await answerButton(answer).props.onClick();
		expect(request).toHaveBeenCalledWith({ invitationId: "invitation-a" });
		expect(errorMessage()).toBe("auth.errors.unknown");
		expect(elements(render()).find((element) => element.type === "alert")?.props.variant).toBe(
			"error",
		);
		expect(buttons().every((element) => !element.props.disabled && !element.props.loading)).toBe(
			true,
		);
		expect(state.invalidate).not.toHaveBeenCalled();
		expect(state.replace).not.toHaveBeenCalled();

		const retry = deferred<{ error: null }>();
		request.mockReturnValueOnce(retry.promise);
		const submission = answerButton(answer).props.onClick();
		expect(errorMessage()).toBeUndefined();
		expect(answerButton(answer).props.loading).toBe(true);
		expect(buttons().every((element) => element.props.disabled)).toBe(true);
		expect(state.replace).not.toHaveBeenCalled();
		retry.resolve({ error: null });
		await submission;
		expect(request).toHaveBeenCalledTimes(2);
		expect(errorMessage()).toBeUndefined();
		expect(buttons().every((element) => !element.props.disabled && !element.props.loading)).toBe(
			true,
		);
		expect(state.replace).toHaveBeenCalledWith(answer === "accept" ? "/customer-team" : "/");
		if (answer === "accept") {
			expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["organizations"] });
			expect(state.reject).not.toHaveBeenCalled();
		} else {
			expect(state.invalidate).not.toHaveBeenCalled();
			expect(state.accept).not.toHaveBeenCalled();
		}
	});

	it("waits for the organization cache refresh before navigating after acceptance", async () => {
		const refresh = deferred<void>();
		state.invalidate.mockReturnValueOnce(refresh.promise);
		const submission = answerButton("accept").props.onClick();
		await vi.waitFor(() => expect(state.invalidate).toHaveBeenCalledOnce());
		expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["organizations"] });
		expect(state.replace).not.toHaveBeenCalled();
		expect(answerButton("accept").props.loading).toBe(true);
		expect(buttons().every((element) => element.props.disabled)).toBe(true);
		refresh.resolve();
		await submission;
		expect(state.replace).toHaveBeenCalledWith("/customer-team");
		expect(errorMessage()).toBeUndefined();
	});
});
