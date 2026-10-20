"use client";

import { useUserAccountsQuery } from "@auth/lib/api";
import { config } from "@repo/auth/config";
import { Button } from "@repo/ui/components/button";
import { ActiveSessionsBlock } from "@settings/components/ActiveSessionsBlock";
import { ChangePasswordForm } from "@settings/components/ChangePassword";
import { ConnectedAccountsBlock } from "@settings/components/ConnectedAccountsBlock";
import { PasskeysBlock } from "@settings/components/PasskeysBlock";
import { SetPasswordForm } from "@settings/components/SetPassword";
import { TwoFactorBlock } from "@settings/components/TwoFactorBlock";
import { useTranslations } from "next-intl";

export function SecurityPanel() {
	const t = useTranslations("studio");
	const accounts = useUserAccountsQuery();
	if (accounts.isPending) return <output>{t("loading")}</output>;
	if (accounts.isError)
		return (
			<div role="alert">
				<p>{t("error")}</p>
				<Button variant="secondary" className="mt-3" onClick={() => void accounts.refetch()}>
					{t("retry")}
				</Button>
			</div>
		);
	const hasPassword = accounts.data?.some((account) => account.providerId === "credential");
	return (
		<div className="space-y-6">
			{config.enablePasswordLogin && (hasPassword ? <ChangePasswordForm /> : <SetPasswordForm />)}
			{config.enableSocialLogin && <ConnectedAccountsBlock />}
			{config.enablePasskeys && <PasskeysBlock />}
			{config.enableTwoFactor && <TwoFactorBlock />}
			<ActiveSessionsBlock />
		</div>
	);
}
