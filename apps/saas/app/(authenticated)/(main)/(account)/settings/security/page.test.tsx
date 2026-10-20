import { userAccountQueryKey, userPasskeyQueryKey } from "@auth/lib/api";
import { createQueryClient } from "@shared/lib/query-client";
import { hydrate, HydrationBoundary } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getUserAccounts: vi.fn(),
	getUserPasskeys: vi.fn(),
	config: {
		enablePasswordLogin: true,
		enableSocialLogin: true,
		enablePasskeys: true,
		enableTwoFactor: true,
	},
}));

vi.mock("@auth/lib/server", () => mocks);
vi.mock("@repo/auth/config", () => ({ config: mocks.config }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@settings/components/ActiveSessionsBlock", () => ({ ActiveSessionsBlock: "sessions" }));
vi.mock("@settings/components/ChangePassword", () => ({ ChangePasswordForm: "change-password" }));
vi.mock("@settings/components/ConnectedAccountsBlock", () => ({
	ConnectedAccountsBlock: "accounts",
}));
vi.mock("@settings/components/PasskeysBlock", () => ({ PasskeysBlock: "passkeys" }));
vi.mock("@settings/components/SetPassword", () => ({ SetPasswordForm: "set-password" }));
vi.mock("@settings/components/TwoFactorBlock", () => ({ TwoFactorBlock: "two-factor" }));
vi.mock("@shared/components/PageHeader", () => ({ PageHeader: "header" }));
vi.mock("@shared/components/SettingsList", () => ({ SettingsList: "settings" }));

import AccountSettingsPage from "./page";

describe("security settings data", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.config.enablePasskeys = true;
		mocks.getSession.mockResolvedValue({ user: { id: "user-a" } });
		mocks.getUserAccounts.mockResolvedValue([{ providerId: "credential" }]);
		mocks.getUserPasskeys.mockResolvedValue([{ id: "passkey-a" }]);
	});

	it("starts independent account and passkey reads after authentication", async () => {
		let resolveAccounts!: (value: unknown[]) => void;
		mocks.getUserAccounts.mockReturnValue(
			new Promise((resolve) => {
				resolveAccounts = resolve;
			}),
		);
		const page = AccountSettingsPage();
		try {
			await vi.waitFor(() => {
				expect(mocks.getUserAccounts).toHaveBeenCalledOnce();
				expect(mocks.getUserPasskeys).toHaveBeenCalledOnce();
			});
		} finally {
			resolveAccounts([]);
			await page;
		}
	});

	it("hydrates both queries from the page without a newly rendered parent layout", async () => {
		const page = await AccountSettingsPage();
		expect(page.type).toBe(HydrationBoundary);
		const browserClient = createQueryClient();
		hydrate(browserClient, page.props.state);
		const readAccounts = vi.fn();
		const readPasskeys = vi.fn();
		expect(
			await browserClient.fetchQuery({ queryKey: userAccountQueryKey, queryFn: readAccounts }),
		).toEqual([{ providerId: "credential" }]);
		expect(
			await browserClient.fetchQuery({ queryKey: userPasskeyQueryKey, queryFn: readPasskeys }),
		).toEqual([{ id: "passkey-a" }]);
		expect(readAccounts).not.toHaveBeenCalled();
		expect(readPasskeys).not.toHaveBeenCalled();
		expect(page.props.state.queries).toHaveLength(2);
		browserClient.clear();
	});

	it("does not request disabled passkeys", async () => {
		mocks.config.enablePasskeys = false;
		const page = await AccountSettingsPage();
		expect(mocks.getUserPasskeys).not.toHaveBeenCalled();
		expect(page.props.state.queries.map((query: { queryKey: unknown }) => query.queryKey)).toEqual([
			userAccountQueryKey,
		]);
	});

	it("does not fetch account details without a session", async () => {
		mocks.getSession.mockResolvedValue(null);
		await expect(AccountSettingsPage()).rejects.toMatchObject({
			digest: "NEXT_REDIRECT;replace;/login;307;",
		});
		expect(mocks.getUserAccounts).not.toHaveBeenCalled();
		expect(mocks.getUserPasskeys).not.toHaveBeenCalled();
	});
});
