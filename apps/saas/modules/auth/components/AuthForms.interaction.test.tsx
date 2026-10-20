import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	cursor: 0,
	states: [] as unknown[],
	refCursor: 0,
	refs: [] as Array<{ current: unknown }>,
	search: new URLSearchParams(),
	values: {} as Record<string, string>,
	formState: {
		isSubmitting: false,
		isSubmitted: false,
		isSubmitSuccessful: false,
		errors: {} as { root?: { message: string } },
	},
	submissions: 0,
	config: {
		enablePasswordLogin: true,
		enableMagicLink: true,
		enablePasskeys: true,
		enableSignup: true,
		enableSocialLogin: true,
	},
	replace: vi.fn(),
	push: vi.fn(),
	invalidate: vi.fn(),
	load: vi.fn(),
	preload: vi.fn(),
	email: vi.fn(),
	magicLink: vi.fn(),
	passkey: vi.fn(),
	signup: vi.fn(),
	acceptInvitation: vi.fn(),
	forgot: vi.fn(),
	reset: vi.fn(),
	verify: vi.fn(),
	capture: vi.fn(),
	completeAttribution: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useEffect: (effect: () => unknown, dependencies?: unknown[]) => {
		if (dependencies?.length === 0) effect();
	},
	useRef: <T,>(initial: T) => {
		const index = state.refCursor++;
		state.refs[index] ??= { current: initial };
		return state.refs[index] as { current: T };
	},
	useState: <T,>(initial: T) => {
		const index = state.cursor++;
		if (!(index in state.states)) state.states[index] = initial;
		return [
			state.states[index] as T,
			(next: T) => {
				state.states[index] = next;
			},
		] as const;
	},
}));
vi.mock("react-hook-form", () => ({
	// Keep RHF's value/error/pending boundary explicit; exercise the real form handlers.
	useForm: () => ({
		control: {},
		formState: state.formState,
		watch: (key: string) => state.values[key],
		setValue: (key: string, value: string) => {
			state.values[key] = value;
		},
		clearErrors: () => {
			delete state.formState.errors.root;
		},
		setError: (_: string, error: { message: string }) => {
			state.formState.errors.root = error;
		},
		handleSubmit: (submit: (values: Record<string, string>) => Promise<void>) => async () => {
			state.submissions++;
			state.formState.isSubmitting = true;
			delete state.formState.errors.root;
			try {
				await submit({ ...state.values });
				state.formState.isSubmitted = true;
				state.formState.isSubmitSuccessful = !state.formState.errors.root;
			} finally {
				state.formState.isSubmitting = false;
			}
		},
	}),
}));
vi.mock("@auth/lib/auth-client", () => ({
	loadAuthClient: state.load,
	preloadAuthClient: state.preload,
}));
vi.mock("@auth/lib/api", () => ({ sessionQueryKey: ["user", "session"] }));
vi.mock("@auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (code?: string) => `auth.error.${code ?? "unknown"}`,
	}),
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: null, loaded: true }),
}));
vi.mock("@config", () => ({ config: { redirectAfterSignIn: "/create" } }));
vi.mock("@repo/auth/config", () => ({ config: state.config }));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: state.replace, push: state.push }),
	useSearchParams: () => state.search,
}));
vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ replace: state.replace, push: state.push }),
}));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@repo/ui/components/button", () => ({ Button: "button" }));
vi.mock("@repo/ui/components/input", () => ({ Input: "input" }));
vi.mock("@repo/ui/components/form", () => ({
	Form: "form-provider",
	FormControl: "form-control",
	FormField: "form-field",
	FormItem: "form-item",
	FormLabel: "label",
	FormMessage: "form-message",
}));
vi.mock("@repo/ui/components/input-otp", () => ({
	InputOTP: "otp-input",
	InputOTPGroup: "otp-group",
	InputOTPSeparator: "otp-separator",
	InputOTPSlot: "otp-slot",
}));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: "alert",
	AlertTitle: "alert-title",
	AlertDescription: "alert-description",
}));
vi.mock("@shared/components/PasswordInput", () => ({ PasswordInput: "password-input" }));
vi.mock("@organizations/components/OrganizationInvitationAlert", () => ({
	OrganizationInvitationAlert: "invitation-alert",
}));
vi.mock("@shared/lib/purchase-attribution", () => ({
	captureRegistrationFirstTouch: state.capture,
	completeRegistrationAttribution: state.completeAttribution,
}));
vi.mock("./SocialSigninButton", () => ({ SocialSigninButton: "social-signin" }));
vi.mock("./LoginModeSwitch", () => ({ LoginModeSwitch: "login-mode-switch" }));

import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { LoginForm } from "./LoginForm";
import { OtpForm } from "./OtpForm";
import { ResetPasswordForm } from "./ResetPasswordForm";
import { SignupForm } from "./SignupForm";

const client = {
	signIn: { email: state.email, magicLink: state.magicLink, passkey: state.passkey },
	signUp: { email: state.signup },
	organization: { acceptInvitation: state.acceptInvitation },
	requestPasswordReset: state.forgot,
	resetPassword: state.reset,
	twoFactor: { verifyTotp: state.verify },
};

const forms = [
	{ name: "login", component: LoginForm, request: state.email },
	{ name: "signup", component: () => SignupForm({}), request: state.signup },
	{ name: "forgot-password", component: ForgotPasswordForm, request: state.forgot },
	{ name: "reset-password", component: ResetPasswordForm, request: state.reset },
	{ name: "OTP", component: OtpForm, request: state.verify },
];

function renderForm(component: () => ReactElement) {
	state.cursor = 0;
	state.refCursor = 0;
	component();
	// Apply the login hydration effect before inspecting interactive controls.
	state.cursor = 0;
	state.refCursor = 0;
	return component();
}

type Element = ReactElement<Record<string, any>>;

function findElement(
	node: ReactNode,
	type: string,
	matches: (element: Element) => boolean = () => true,
): Element | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findElement(child, type, matches);
			if (found) return found;
		}
		return undefined;
	}
	if (!isValidElement<Record<string, any>>(node)) return undefined;
	if (node.type === type && matches(node)) return node;
	return findElement(node.props.children, type, matches);
}

function required(node: ReactNode, type: string, matches?: (element: Element) => boolean) {
	const element = findElement(node, type, matches);
	if (!element) throw new Error(`Missing ${type}`);
	return element;
}

function form(component: () => ReactElement) {
	return required(renderForm(component), "form");
}

function passkeyButton() {
	return required(
		renderForm(LoginForm),
		"button",
		(element) =>
			Array.isArray(element.props.children) &&
			element.props.children.includes("auth.login.loginWithPasskey"),
	);
}

function fieldInput(component: () => ReactElement, name: string, type: string) {
	const field = required(
		renderForm(component),
		"form-field",
		(element) => element.props.name === name,
	);
	return required(
		field.props.render({
			field: {
				name,
				value: state.values[name],
				onChange: (value: string) => {
					state.values[name] = value;
				},
			},
		}),
		type,
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("deferred authentication form interactions", () => {
	afterEach(() => vi.unstubAllGlobals());
	beforeEach(() => {
		state.cursor = 0;
		state.states = [];
		state.refCursor = 0;
		state.refs = [];
		state.search = new URLSearchParams();
		state.submissions = 0;
		state.values = {
			email: "customer@example.com",
			password: "Valid-password-1!",
			name: "Customer",
			mode: "password",
			code: "123456",
		};
		state.formState = {
			isSubmitting: false,
			isSubmitted: false,
			isSubmitSuccessful: false,
			errors: {},
		};
		state.config.enableSignup = true;
		state.config.enablePasswordLogin = true;
		for (const method of [
			state.email,
			state.magicLink,
			state.passkey,
			state.signup,
			state.acceptInvitation,
			state.forgot,
			state.reset,
			state.verify,
		]) {
			method.mockReset().mockResolvedValue({ data: {}, error: null });
		}
		state.load.mockReset().mockResolvedValue(client);
		state.preload.mockReset();
		state.capture.mockReset().mockResolvedValue(undefined);
		state.completeAttribution.mockReset();
		state.replace.mockReset();
		state.push.mockReset();
		state.invalidate.mockReset().mockResolvedValue(undefined);
		vi.stubGlobal("window", { location: { origin: "https://ezimageai.com" } });
	});

	it.each(forms)(
		"keeps $name idle, then submits once while the SDK is delayed",
		async ({ component, request }) => {
			const sdk = deferred<typeof client>();
			state.load.mockReturnValueOnce(sdk.promise);
			const element = form(component);
			expect(state.load).not.toHaveBeenCalled();
			element.props.onFocusCapture();
			element.props.onPointerEnter();
			expect(state.preload).toHaveBeenCalledTimes(2);
			expect(request).not.toHaveBeenCalled();

			const event = { preventDefault: vi.fn() };
			const submitting = element.props.onSubmit(event);
			await element.props.onSubmit(event);
			expect(event.preventDefault).toHaveBeenCalledTimes(2);
			expect(state.submissions).toBe(1);
			expect(form(component).props["aria-busy"]).toBe(true);
			expect(state.load).toHaveBeenCalledOnce();
			expect(request).not.toHaveBeenCalled();

			sdk.resolve(client);
			await submitting;
			expect(request).toHaveBeenCalledOnce();
			expect(state.formState.isSubmitting).toBe(false);
		},
	);

	it.each(forms)(
		"lets $name retry after a failed SDK load without reporting success",
		async ({ component, request }) => {
			state.load.mockRejectedValueOnce(new Error("Chunk unavailable"));
			await form(component).props.onSubmit();
			expect(state.formState.errors.root?.message).toBe("auth.error.unknown");
			expect(state.formState.isSubmitSuccessful).toBe(false);
			expect(form(component).props["aria-busy"]).toBe(false);
			expect(request).not.toHaveBeenCalled();

			await form(component).props.onSubmit();
			expect(state.formState.errors.root).toBeUndefined();
			expect(request).toHaveBeenCalledOnce();
		},
	);

	it("keeps two-factor verification ahead of invitation and purchase redirects", async () => {
		state.search = new URLSearchParams({
			invitationId: "invite-a",
			redirectTo: "/pricing?plan=studio",
			email: "customer@example.com",
		});
		state.email.mockResolvedValueOnce({ data: { twoFactorRedirect: true }, error: null });
		await form(LoginForm).props.onSubmit();

		const destination = new URL(state.replace.mock.calls[0][0], "https://ezimageai.com");
		expect(destination.pathname).toBe("/verify");
		expect(destination.searchParams.get("invitationId")).toBe("invite-a");
		expect(destination.searchParams.get("redirectTo")).toBe("/pricing?plan=studio");
		expect(destination.searchParams.get("email")).toBe("customer@example.com");
		expect(state.invalidate).not.toHaveBeenCalled();
	});

	it("retains session invalidation and safe password-login redirects", async () => {
		state.search = new URLSearchParams({ redirectTo: "https://attacker.example/path" });
		await form(LoginForm).props.onSubmit();
		expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["user", "session"] });
		expect(state.replace).toHaveBeenCalledWith("/create");
	});

	it("retains invitation priority for magic links without navigating before email verification", async () => {
		state.values.mode = "magic-link";
		state.search = new URLSearchParams({ invitationId: "invite-a", redirectTo: "/pricing" });
		await form(LoginForm).props.onSubmit();
		expect(state.magicLink).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "customer@example.com",
				callbackURL: "/organization-invitation/invite-a",
			}),
		);
		expect(state.replace).not.toHaveBeenCalled();
	});

	it("waits for attribution before signup and keeps invitation acceptance after account creation", async () => {
		const capture = deferred<void>();
		state.capture.mockReturnValueOnce(capture.promise);
		state.config.enableSignup = false;
		state.search = new URLSearchParams({ invitationId: "invite-a", redirectTo: "/pricing" });
		const submitting = form(() => SignupForm({})).props.onSubmit();
		await Promise.resolve();
		expect(state.signup).not.toHaveBeenCalled();

		capture.resolve();
		await submitting;
		expect(state.signup).toHaveBeenCalledWith({
			email: "customer@example.com",
			name: "Customer",
			password: "Valid-password-1!",
			callbackURL: "/organization-invitation/invite-a",
		});
		expect(state.completeAttribution).toHaveBeenCalledOnce();
		expect(state.acceptInvitation).toHaveBeenCalledWith({ invitationId: "invite-a" });
		expect(state.acceptInvitation.mock.invocationCallOrder[0]).toBeGreaterThan(
			state.signup.mock.invocationCallOrder[0],
		);
		expect(state.push).toHaveBeenCalledWith("/create");
	});

	it("shows passkey progress immediately, blocks overlapping auth, and displays SDK errors before form submission", async () => {
		const sdk = deferred<typeof client>();
		state.load.mockReturnValueOnce(sdk.promise);
		state.passkey.mockResolvedValueOnce({ data: null, error: { code: "INVALID_TOKEN" } });
		const element = passkeyButton();
		const signingIn = element.props.onClick();
		await element.props.onClick();
		await form(LoginForm).props.onSubmit();

		expect(passkeyButton().props).toMatchObject({
			loading: true,
			disabled: true,
			"aria-busy": true,
		});
		expect(state.submissions).toBe(0);
		expect(state.load).toHaveBeenCalledOnce();
		sdk.resolve(client);
		await signingIn;

		expect(state.passkey).toHaveBeenCalledOnce();
		expect(state.formState.isSubmitted).toBe(false);
		expect(required(renderForm(LoginForm), "alert-title").props.children).toBe(
			"auth.error.INVALID_TOKEN",
		);
		expect(state.replace).not.toHaveBeenCalled();
		expect(passkeyButton().props).toMatchObject({ loading: false, disabled: false });

		state.search = new URLSearchParams({ invitationId: "invite-a", redirectTo: "/pricing" });
		await passkeyButton().props.onClick();
		expect(state.formState.errors.root).toBeUndefined();
		expect(state.passkey).toHaveBeenCalledTimes(2);
		expect(state.replace).toHaveBeenCalledWith("/organization-invitation/invite-a");
	});

	it("recovers passkey controls after a network error", async () => {
		state.passkey.mockRejectedValueOnce(new Error("Offline"));
		await passkeyButton().props.onClick();
		expect(state.replace).not.toHaveBeenCalled();
		expect(required(renderForm(LoginForm), "alert-title").props.children).toBe(
			"auth.error.unknown",
		);
		expect(passkeyButton().props.loading).toBe(false);
		await passkeyButton().props.onClick();
		expect(state.replace).toHaveBeenCalledWith("/create");
	});

	it("submits only a complete OTP and prevents an auto-submit plus click from sending two requests", async () => {
		const verification = deferred<{ data: object; error: null }>();
		state.verify.mockReturnValueOnce(verification.promise);
		state.search = new URLSearchParams({ invitationId: "invite-a", redirectTo: "/pricing" });
		const input = fieldInput(OtpForm, "code", "otp-input");
		input.props.onChange("12345");
		expect(state.submissions).toBe(0);
		input.props.onChange("123456");
		await form(OtpForm).props.onSubmit();
		await vi.waitFor(() => expect(state.verify).toHaveBeenCalledWith({ code: "123456" }));
		expect(state.submissions).toBe(1);
		expect(fieldInput(OtpForm, "code", "otp-input").props.disabled).toBe(true);
		verification.resolve({ data: {}, error: null });
		await vi.waitFor(() =>
			expect(state.replace).toHaveBeenCalledWith("/organization-invitation/invite-a"),
		);
	});

	it("preserves ordinary password-manager and one-time-code autofill", () => {
		expect(fieldInput(LoginForm, "email", "input").props.autoComplete).toBe("email");
		expect(fieldInput(LoginForm, "password", "input").props.autoComplete).toBe("current-password");
		expect(fieldInput(() => SignupForm({}), "password", "password-input").props.autoComplete).toBe(
			"new-password",
		);
		expect(fieldInput(ResetPasswordForm, "password", "password-input").props.autoComplete).toBe(
			"new-password",
		);
		expect(fieldInput(OtpForm, "code", "otp-input").props.autoComplete).toBe("one-time-code");
	});
});
