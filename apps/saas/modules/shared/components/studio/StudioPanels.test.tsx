import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => ({ back: undefined as (() => void) | undefined }));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: { id: "owner" } }) }));
vi.mock("@auth/lib/api", () => ({ useUserAccountsQuery: vi.fn() }));
vi.mock("@payments/hooks/purchases", () => ({ usePurchases: vi.fn() }));
vi.mock("@repo/auth/config", () => ({ config: {} }));
vi.mock("@media/components/AssetLibrary", () => ({ AssetLibrary: () => null }));
vi.mock("@media/components/editor/EditorResultPanel", () => ({
	EditorResultPanel: ({ jobId }: { jobId: string }) => <div>Result: {jobId}</div>,
}));
vi.mock("@media/components/JobHistory", () => ({ JobHistory: () => <div>History list</div> }));
vi.mock("@payments/components/ActivePlan", () => ({ ActivePlan: () => null }));
vi.mock("@payments/components/ChangePlan", () => ({ ChangePlan: () => null }));
vi.mock("@settings/components/ActiveSessionsBlock", () => ({ ActiveSessionsBlock: () => null }));
vi.mock("@settings/components/ChangeEmailForm", () => ({ ChangeEmailForm: () => null }));
vi.mock("@settings/components/ChangeNameForm", () => ({ ChangeNameForm: () => null }));
vi.mock("@settings/components/ChangePassword", () => ({ ChangePasswordForm: () => null }));
vi.mock("@settings/components/ConnectedAccountsBlock", () => ({
	ConnectedAccountsBlock: () => null,
}));
vi.mock("@settings/components/DeleteAccountForm", () => ({ DeleteAccountForm: () => null }));
vi.mock("@settings/components/NotificationPreferencesForm", () => ({
	NotificationPreferencesForm: () => null,
}));
vi.mock("@settings/components/PasskeysBlock", () => ({ PasskeysBlock: () => null }));
vi.mock("@settings/components/SetPassword", () => ({ SetPasswordForm: () => null }));
vi.mock("@settings/components/TwoFactorBlock", () => ({ TwoFactorBlock: () => null }));
vi.mock("@settings/components/UserAvatarForm", () => ({ UserAvatarForm: () => null }));
vi.mock("@settings/components/UserLanguageForm", () => ({ UserLanguageForm: () => null }));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => {
		callbacks.back = onClick;
		return <button onClick={onClick}>{children}</button>;
	},
}));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) =>
		namespace === "media.detail" && key === "back" ? "Back to history" : key,
}));

import { StudioPanels } from "./StudioPanels";

describe("history panel navigation", () => {
	beforeEach(() => {
		callbacks.back = undefined;
	});

	it("offers an explicit back action that returns to the list without closing the panel", () => {
		const onChange = vi.fn();
		const onClose = vi.fn();
		const props: ComponentProps<typeof StudioPanels> = {
			panel: { kind: "history", jobId: "first-job" },
			onChange,
			onClose,
		};
		const markup = renderToStaticMarkup(<StudioPanels {...props} />);
		expect(markup).toContain("Back to history");
		expect(markup).toContain("Result: first-job");
		callbacks.back?.();
		expect(onChange).toHaveBeenCalledWith({ kind: "history" });
		expect(onClose).not.toHaveBeenCalled();
		expect(renderToStaticMarkup(<StudioPanels {...props} panel={{ kind: "history" }} />)).toContain(
			"History list",
		);
	});
});
