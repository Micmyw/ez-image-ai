import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	refCursor: 0,
	refs: [] as Array<{ current: unknown }>,
	formState: {
		isSubmitting: false,
		errors: {} as { root?: { message: string } },
	},
	updateUser: vi.fn(),
	clearCache: vi.fn(),
	replace: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useEffect: vi.fn(),
	useMemo: <T,>(factory: () => T) => factory(),
	useRef: <T,>(initial: T) => {
		const index = state.refCursor++;
		state.refs[index] ??= { current: initial };
		return state.refs[index] as { current: T };
	},
}));
vi.mock("react-hook-form", () => ({
	useForm: () => ({
		control: {},
		formState: state.formState,
		clearErrors: () => {
			delete state.formState.errors.root;
		},
		setError: (_: string, error: { message: string }) => {
			state.formState.errors.root = error;
		},
		handleSubmit: (submit: (values: { name: string }) => Promise<void>) => async () => {
			state.formState.isSubmitting = true;
			try {
				await submit({ name: "Customer" });
			} finally {
				state.formState.isSubmitting = false;
			}
		},
	}),
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "customer", name: "Customer" } }),
}));
vi.mock("@repo/auth/client", () => ({ authClient: { updateUser: state.updateUser } }));
vi.mock("@shared/lib/cache", () => ({ clearCache: state.clearCache }));
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: state.replace }),
}));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams({ redirectTo: "/pricing?plan=studio" }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@repo/ui/components/button", () => ({ Button: "button" }));
vi.mock("@repo/ui/components/input", () => ({ Input: "input" }));
vi.mock("@repo/ui/components/progress", () => ({ Progress: "progress" }));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: "alert",
	AlertDescription: "alert-description",
}));
vi.mock("@repo/ui/components/form", () => ({
	Form: "form-provider",
	FormControl: "form-control",
	FormDescription: "form-description",
	FormField: "form-field",
	FormItem: "form-item",
	FormLabel: "label",
}));
vi.mock("@settings/components/UserAvatarUpload", () => ({ UserAvatarUpload: "avatar-upload" }));

import { OnboardingAccountStep } from "./OnboardingAccountStep";
import { OnboardingForm } from "./OnboardingForm";

type Element = ReactElement<Record<string, any>>;

function elements(node: ReactNode): Element[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!isValidElement<Record<string, any>>(node)) return [];
	return [node, ...elements(node.props.children)];
}

function renderStep() {
	state.refCursor = 0;
	const step = elements(OnboardingForm()).find((element) => element.type === OnboardingAccountStep);
	if (!step) throw new Error("Onboarding step missing");
	return OnboardingAccountStep({
		onCompleted: step.props.onCompleted,
	});
}

function form() {
	const node = elements(renderStep()).find((element) => element.type === "form");
	if (!node) throw new Error("Onboarding form missing");
	return node;
}

function button() {
	const node = elements(renderStep()).find((element) => element.type === "button");
	if (!node) throw new Error("Onboarding button missing");
	return node;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("onboarding completion feedback", () => {
	beforeEach(() => {
		state.refCursor = 0;
		state.refs = [];
		state.formState = { isSubmitting: false, errors: {} };
		state.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
		state.clearCache.mockReset().mockResolvedValue(undefined);
		state.replace.mockReset();
	});

	it("keeps busy and blocks duplicate submits through completion and cache refresh", async () => {
		const completion = deferred<{ data: object; error: null }>();
		const refresh = deferred<void>();
		state.updateUser
			.mockResolvedValueOnce({ data: {}, error: null })
			.mockReturnValueOnce(completion.promise);
		state.clearCache.mockReturnValueOnce(refresh.promise);
		const element = form();
		const event = { preventDefault: vi.fn() };
		const submitting = element.props.onSubmit(event);
		await vi.waitFor(() => expect(state.updateUser).toHaveBeenCalledTimes(2));
		await element.props.onSubmit(event);
		expect(button().props.loading).toBe(true);
		expect(form().props["aria-busy"]).toBe(true);
		expect(state.updateUser.mock.calls).toEqual([
			[{ name: "Customer" }],
			[{ onboardingComplete: true }],
		]);
		expect(state.clearCache).not.toHaveBeenCalled();
		expect(state.replace).not.toHaveBeenCalled();

		completion.resolve({ data: {}, error: null });
		await vi.waitFor(() => expect(state.clearCache).toHaveBeenCalledOnce());
		expect(button().props.loading).toBe(true);
		await form().props.onSubmit(event);
		expect(state.updateUser).toHaveBeenCalledTimes(2);
		expect(state.replace).not.toHaveBeenCalled();

		refresh.resolve();
		await submitting;
		expect(button().props.loading).toBe(false);
		expect(state.replace).toHaveBeenCalledWith("/pricing?plan=studio");
	});

	it.each(["name-response", "completion-response", "network"] as const)(
		"shows %s failures, stops dependent work and allows a retry",
		async (failure) => {
			if (failure === "name-response") {
				state.updateUser.mockResolvedValueOnce({
					data: null,
					error: { code: "FAILED_TO_UPDATE_USER" },
				});
			} else if (failure === "completion-response") {
				state.updateUser
					.mockResolvedValueOnce({ data: {}, error: null })
					.mockResolvedValueOnce({ data: null, error: { code: "FAILED_TO_UPDATE_USER" } });
			} else {
				state.updateUser.mockRejectedValueOnce(new Error("Offline"));
			}
			await form().props.onSubmit();
			const failedCalls = failure === "completion-response" ? 2 : 1;
			expect(state.updateUser).toHaveBeenCalledTimes(failedCalls);
			expect(state.clearCache).not.toHaveBeenCalled();
			expect(state.replace).not.toHaveBeenCalled();
			expect(button().props.loading).toBe(false);
			expect(
				elements(renderStep()).find((element) => element.type === "alert-description")?.props
					.children,
			).toBe("onboarding.notifications.accountSetupFailed");

			await form().props.onSubmit();
			expect(state.updateUser).toHaveBeenCalledTimes(failedCalls + 2);
			expect(state.formState.errors.root).toBeUndefined();
			expect(state.clearCache).toHaveBeenCalledOnce();
			expect(state.replace).toHaveBeenCalledWith("/pricing?plan=studio");
		},
	);
});
