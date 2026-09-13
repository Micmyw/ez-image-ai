import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	updateUser: vi.fn().mockResolvedValue({}),
	updateLocale: vi.fn(),
	refresh: vi.fn(),
	select: null as null | ((value: string) => void),
}));
vi.mock("@repo/auth/client", () => ({ authClient: { updateUser: state.updateUser } }));
vi.mock("@i18n/lib/update-locale", () => ({ updateLocale: state.updateLocale }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: state.refresh }) }));
vi.mock("next-intl", () => ({
	useLocale: () => "en",
	useTranslations: () => (key: string) => key,
}));
vi.mock("@repo/ui/components/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("@shared/components/SettingsItem", () => ({
	SettingsItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: ({ mutationFn }: { mutationFn: (value?: string) => Promise<void> }) => ({
		isPending: false,
		mutateAsync: mutationFn,
	}),
}));
vi.mock("@repo/ui/components/select", () => ({
	Select: ({
		onValueChange,
		children,
	}: {
		onValueChange: (value: string) => void;
		children: ReactNode;
	}) => {
		state.select = onValueChange;
		return <div>{children}</div>;
	},
	SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	SelectValue: () => <span />,
	SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { UserLanguageForm } from "./UserLanguageForm";

it("saves the newly selected locale on the first change", async () => {
	renderToStaticMarkup(<UserLanguageForm />);
	state.select!("de");
	await vi.waitFor(() => expect(state.updateUser).toHaveBeenCalledWith({ locale: "de" }));
	expect(state.updateLocale).toHaveBeenCalledWith("de");
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalled());
});
