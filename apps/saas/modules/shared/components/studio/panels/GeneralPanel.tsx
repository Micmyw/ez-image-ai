"use client";

import { ChangeEmailForm } from "@settings/components/ChangeEmailForm";
import { ChangeNameForm } from "@settings/components/ChangeNameForm";
import { DeleteAccountForm } from "@settings/components/DeleteAccountForm";
import { UserAvatarForm } from "@settings/components/UserAvatarForm";
import { UserLanguageForm } from "@settings/components/UserLanguageForm";

export function GeneralPanel() {
	return (
		<div className="space-y-6">
			<UserAvatarForm />
			<ChangeNameForm />
			<UserLanguageForm />
			<ChangeEmailForm />
			<DeleteAccountForm />
		</div>
	);
}
