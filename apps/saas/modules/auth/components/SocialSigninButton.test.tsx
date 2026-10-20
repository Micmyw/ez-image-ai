import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	cursor: 0,
	states: [] as unknown[],
	refCursor: 0,
	refs: [] as Array<{ current: unknown }>,
	redirectTo: null as string | null,
	invitationId: null as string | null,
	signIn: vi.fn(),
	capture: vi.fn(),
	load: vi.fn(),
	preload: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
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
vi.mock("@config", () => ({ config: { redirectAfterSignIn: "/create" } }));
vi.mock("@auth/lib/auth-client", () => ({
	loadAuthClient: state.load,
	preloadAuthClient: state.preload,
}));
vi.mock("@auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (code?: string) => `auth.error.${code ?? "unknown"}`,
	}),
}));
vi.mock("@repo/ui/components/button", () => ({ Button: "button" }));
vi.mock("@shared/lib/purchase-attribution", () => ({
	captureRegistrationFirstTouch: state.capture,
}));
vi.mock("nuqs", () => ({
	parseAsString: {},
	useQueryState: (key: string) => [key === "redirectTo" ? state.redirectTo : state.invitationId],
}));

import { SocialSigninButton } from "./SocialSigninButton";

function renderButton(provider: "google" | "github" = "google", disabled = false) {
	state.cursor = 0;
	state.refCursor = 0;
	return SocialSigninButton({ provider, disabled });
}

function findElement(node: ReactNode, type: string): ReactElement<Record<string, any>> | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findElement(child, type);
			if (found) return found;
		}
		return undefined;
	}
	if (!isValidElement<Record<string, any>>(node)) return undefined;
	if (node.type === type) return node;
	return findElement(node.props.children, type);
}

function button(provider: "google" | "github" = "google", disabled = false) {
	const element = findElement(renderButton(provider, disabled), "button");
	if (!element) throw new Error("Sign-in button missing");
	return element;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("OAuth purchase return", () => {
	afterEach(() => vi.unstubAllGlobals());
	beforeEach(() => {
		state.cursor = 0;
		state.states = [];
		state.refCursor = 0;
		state.refs = [];
		state.redirectTo = null;
		state.invitationId = null;
		state.signIn.mockReset().mockResolvedValue({ data: {}, error: null });
		state.capture.mockReset().mockResolvedValue(undefined);
		state.load.mockReset().mockResolvedValue({ signIn: { social: state.signIn } });
		state.preload.mockReset();
		vi.stubGlobal("window", { location: { origin: "https://ezimageai.com" } });
	});
	it("keeps the selected pricing destination and captures consented signup context before leaving", async () => {
		state.redirectTo = "/pricing?plan=studio&interval=month";
		const element = button();
		await element.props.onClick();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.signIn).toHaveBeenCalledWith({
			provider: "google",
			callbackURL: "https://ezimageai.com/pricing?plan=studio&interval=month",
		});
	});
	it.each(["https://attacker.com/path", "//attacker.com/path", "/\\attacker.com/path"])(
		"rejects external redirect %s",
		async (redirectTo) => {
			state.redirectTo = redirectTo;
			await button("github").props.onClick();
			expect(state.signIn).toHaveBeenCalledWith({
				provider: "github",
				callbackURL: "https://ezimageai.com/create",
			});
		},
	);
	it("preserves invitation precedence", async () => {
		state.redirectTo = "/pricing";
		state.invitationId = "invitation-a";
		await button().props.onClick();
		expect(state.signIn).toHaveBeenCalledWith({
			provider: "google",
			callbackURL: "https://ezimageai.com/organization-invitation/invitation-a",
		});
	});

	it("warms only the SDK on focus or pointer intent", () => {
		const element = button();
		expect(state.load).not.toHaveBeenCalled();
		element.props.onFocus();
		element.props.onPointerEnter();
		expect(state.preload).toHaveBeenCalledTimes(2);
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.signIn).not.toHaveBeenCalled();
	});

	it("shows busy feedback immediately and submits once after delayed attribution is ready", async () => {
		const capture = deferred<void>();
		state.capture.mockReturnValueOnce(capture.promise);
		const element = button();
		const signingIn = element.props.onClick();
		await element.props.onClick();

		expect(button().props).toMatchObject({
			loading: true,
			disabled: true,
			"aria-busy": true,
		});
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.load).toHaveBeenCalledOnce();
		expect(state.signIn).not.toHaveBeenCalled();

		capture.resolve();
		await signingIn;
		expect(state.signIn).toHaveBeenCalledOnce();
		expect(button().props.loading).toBe(false);
	});

	it("also blocks repeated clicks while the SDK chunk is loading", async () => {
		const sdk = deferred<{ signIn: { social: typeof state.signIn } }>();
		state.load.mockReturnValueOnce(sdk.promise);
		const element = button();
		const signingIn = element.props.onClick();
		await element.props.onClick();
		expect(button().props.loading).toBe(true);
		expect(state.signIn).not.toHaveBeenCalled();
		sdk.resolve({ signIn: { social: state.signIn } });
		await signingIn;
		expect(state.signIn).toHaveBeenCalledOnce();
	});

	it.each(["chunk", "response", "network"] as const)(
		"restores a usable button and shows an error after a %s failure",
		async (failure) => {
			if (failure === "chunk") state.load.mockRejectedValueOnce(new Error("Chunk unavailable"));
			if (failure === "network") state.signIn.mockRejectedValueOnce(new Error("Offline"));
			if (failure === "response") {
				state.signIn.mockResolvedValueOnce({ data: null, error: { code: "PROVIDER_NOT_FOUND" } });
			}

			await button().props.onClick();
			expect(button().props).toMatchObject({ loading: false, disabled: false });
			expect(findElement(renderButton(), "p")?.props).toMatchObject({
				role: "alert",
				children: `auth.error.${failure === "response" ? "PROVIDER_NOT_FOUND" : "unknown"}`,
			});

			const retry = button().props.onClick();
			expect(findElement(renderButton(), "p")).toBeUndefined();
			await retry;
			expect(state.signIn).toHaveBeenCalledTimes(failure === "chunk" ? 1 : 2);
			expect(button().props.loading).toBe(false);
		},
	);

	it("does not start a second auth flow when disabled by the parent form", async () => {
		await button("google", true).props.onClick();
		expect(state.load).not.toHaveBeenCalled();
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.signIn).not.toHaveBeenCalled();
	});
});
