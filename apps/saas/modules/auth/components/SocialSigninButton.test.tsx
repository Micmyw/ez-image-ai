import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	redirectTo: null as string | null,
	invitationId: null as string | null,
	signIn: vi.fn(),
	capture: vi.fn(),
}));
vi.mock("@config", () => ({ config: { redirectAfterSignIn: "/create" } }));
vi.mock("@repo/auth/client", () => ({ authClient: { signIn: { social: state.signIn } } }));
vi.mock("@repo/ui/components/button", () => ({ Button: "button" }));
vi.mock("@shared/lib/purchase-attribution", () => ({
	captureRegistrationFirstTouch: state.capture,
}));
vi.mock("nuqs", () => ({
	parseAsString: {},
	useQueryState: (key: string) => [key === "redirectTo" ? state.redirectTo : state.invitationId],
}));

import { SocialSigninButton } from "./SocialSigninButton";

describe("OAuth purchase return", () => {
	afterEach(() => vi.unstubAllGlobals());
	beforeEach(() => {
		state.redirectTo = null;
		state.invitationId = null;
		state.signIn.mockReset();
		state.capture.mockReset();
		vi.stubGlobal("window", { location: { origin: "https://ezimageai.com" } });
	});
	it("keeps the selected pricing destination and captures consented signup context before leaving", async () => {
		state.redirectTo = "/pricing?plan=studio&interval=month";
		const element = SocialSigninButton({ provider: "google" });
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
			await SocialSigninButton({ provider: "github" }).props.onClick();
			expect(state.signIn).toHaveBeenCalledWith({
				provider: "github",
				callbackURL: "https://ezimageai.com/create",
			});
		},
	);
	it("preserves invitation precedence", async () => {
		state.redirectTo = "/pricing";
		state.invitationId = "invitation-a";
		await SocialSigninButton({ provider: "google" }).props.onClick();
		expect(state.signIn).toHaveBeenCalledWith({
			provider: "google",
			callbackURL: "https://ezimageai.com/organization-invitation/invitation-a",
		});
	});
});
