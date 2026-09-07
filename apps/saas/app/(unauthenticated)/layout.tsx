import { SessionProvider } from "@auth/components/SessionProvider";
import { AuthWrapper } from "@shared/components/AuthWrapper";
import { getTranslations } from "next-intl/server";
import type { PropsWithChildren } from "react";

export default async function AuthLayout({ children }: PropsWithChildren) {
	const t = await getTranslations();

	return (
		<SessionProvider>
			<AuthWrapper
				variant="product"
				productCopy={{
					eyebrow: t("media.create.eyebrow"),
					title: t("media.create.title"),
					description: t("media.create.subtitle"),
					sequence: t("media.create.workspace.sequence"),
					privateLabel: t("media.create.workspace.private"),
				}}
			>
				{children}
			</AuthWrapper>
		</SessionProvider>
	);
}
