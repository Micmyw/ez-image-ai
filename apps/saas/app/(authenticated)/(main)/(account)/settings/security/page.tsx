import { userAccountQueryKey, userPasskeyQueryKey } from "@auth/lib/api";
import { getSession, getUserAccounts, getUserPasskeys } from "@auth/lib/server";
import { config } from "@repo/auth/config";
import { ActiveSessionsBlock } from "@settings/components/ActiveSessionsBlock";
import { ChangePasswordForm } from "@settings/components/ChangePassword";
import { ConnectedAccountsBlock } from "@settings/components/ConnectedAccountsBlock";
import { PasskeysBlock } from "@settings/components/PasskeysBlock";
import { SetPasswordForm } from "@settings/components/SetPassword";
import { TwoFactorBlock } from "@settings/components/TwoFactorBlock";
import { PageHeader } from "@shared/components/PageHeader";
import { SettingsList } from "@shared/components/SettingsList";
import { createQueryClient } from "@shared/lib/query-client";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export async function generateMetadata() {
	const t = await getTranslations("settings.account.security");

	return {
		title: t("title"),
	};
}

export default async function AccountSettingsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/login");
	}

	const [userAccounts, userPasskeys, t] = await Promise.all([
		getUserAccounts(),
		config.enablePasskeys ? getUserPasskeys() : undefined,
		getTranslations("settings.account.security"),
	]);

	const userHasPassword = userAccounts?.some((account) => account.providerId === "credential");

	// Page-local state also reaches the browser when the shared layout is reused.
	const queryClient = createQueryClient();
	queryClient.setQueryData(userAccountQueryKey, userAccounts);
	if (userPasskeys !== undefined) {
		queryClient.setQueryData(userPasskeyQueryKey, userPasskeys);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<PageHeader title={t("title")} />

			<SettingsList>
				{config.enablePasswordLogin &&
					(userHasPassword ? <ChangePasswordForm /> : <SetPasswordForm />)}
				{config.enableSocialLogin && <ConnectedAccountsBlock />}
				{config.enablePasskeys && <PasskeysBlock />}
				{config.enableTwoFactor && <TwoFactorBlock />}
				<ActiveSessionsBlock />
			</SettingsList>
		</HydrationBoundary>
	);
}
