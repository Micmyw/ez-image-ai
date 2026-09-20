"use client";

import { useSession } from "@auth/hooks/use-session";
import { useUserAccountsQuery } from "@auth/lib/api";
import { AssetLibrary } from "@media/components/AssetLibrary";
import { EditorResultPanel } from "@media/components/editor/EditorResultPanel";
import { JobHistory } from "@media/components/JobHistory";
import { ActivePlan } from "@payments/components/ActivePlan";
import { ChangePlan } from "@payments/components/ChangePlan";
import { usePurchases } from "@payments/hooks/purchases";
import { config } from "@repo/auth/config";
import { Button } from "@repo/ui/components/button";
import { ActiveSessionsBlock } from "@settings/components/ActiveSessionsBlock";
import { ChangeEmailForm } from "@settings/components/ChangeEmailForm";
import { ChangeNameForm } from "@settings/components/ChangeNameForm";
import { ChangePasswordForm } from "@settings/components/ChangePassword";
import { ConnectedAccountsBlock } from "@settings/components/ConnectedAccountsBlock";
import { DeleteAccountForm } from "@settings/components/DeleteAccountForm";
import { NotificationPreferencesForm } from "@settings/components/NotificationPreferencesForm";
import { PasskeysBlock } from "@settings/components/PasskeysBlock";
import { SetPasswordForm } from "@settings/components/SetPassword";
import { TwoFactorBlock } from "@settings/components/TwoFactorBlock";
import { UserAvatarForm } from "@settings/components/UserAvatarForm";
import { UserLanguageForm } from "@settings/components/UserLanguageForm";
import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { STUDIO_ASSET_SELECTED_EVENT, type StudioPanel } from "./studio-context";

export function StudioPanels({
	panel,
	onChange,
	onClose,
}: {
	panel: StudioPanel;
	onChange: (panel: StudioPanel) => void;
	onClose: () => void;
}) {
	const detail = useTranslations("media.detail");
	const { user } = useSession();
	if (!user) return null;
	switch (panel.kind) {
		case "general":
			return (
				<div className="space-y-6">
					<UserAvatarForm />
					<ChangeNameForm />
					<UserLanguageForm />
					<ChangeEmailForm />
					<DeleteAccountForm />
				</div>
			);
		case "security":
			return <StudioSecurity />;
		case "notifications":
			return <NotificationPreferencesForm />;
		case "billing":
			return <StudioBilling userId={user.id} />;
		case "history":
			return panel.jobId ? (
				<div>
					<Button
						type="button"
						className="mb-4"
						variant="secondary"
						onClick={() => onChange({ kind: "history" })}
					>
						<ArrowLeftIcon className="size-4" aria-hidden="true" />
						{detail("back")}
					</Button>
					<EditorResultPanel jobId={panel.jobId} onNew={onClose} />
				</div>
			) : (
				<JobHistory embedded onSelect={(jobId) => onChange({ kind: "history", jobId })} />
			);
		case "assets":
			return (
				<AssetLibrary
					embedded
					onSelect={(assetId) => {
						window.dispatchEvent(
							new CustomEvent(STUDIO_ASSET_SELECTED_EVENT, { detail: { assetId } }),
						);
						onClose();
					}}
				/>
			);
	}
}

function StudioBilling({ userId }: { userId: string }) {
	const { activePlan } = usePurchases();
	return (
		<div className="space-y-6 studio-billing-plans">
			<ActivePlan />
			<ChangePlan userId={userId} activePlanId={activePlan?.id} />
		</div>
	);
}
function StudioSecurity() {
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
