import { AdminMessagesProvider } from "@admin/components/AdminMessagesProvider";
import { getSession } from "@auth/lib/server";
import { config } from "@repo/auth/config";
import { Logo } from "@repo/ui";
import { SettingsMenu } from "@settings/components/SettingsMenu";
import { PageHeader } from "@shared/components/PageHeader";
import {
	ActivityIcon,
	BarChart3Icon,
	BellRingIcon,
	BotIcon,
	Building2Icon,
	CreditCardIcon,
	LifeBuoyIcon,
	UsersIcon,
} from "lucide-react";
import { getMessages, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type { PropsWithChildren } from "react";

export default async function AdminLayout({ children }: PropsWithChildren) {
	const t = await getTranslations("admin");
	const session = await getSession();

	if (!session) {
		redirect("/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/");
	}
	const { admin } = await getMessages();

	return (
		<AdminMessagesProvider admin={admin}>
			<PageHeader title={t("title")} subtitle={t("description")} />

			<SettingsMenu
				className="mb-6 [&>nav]:flex-wrap"
				menuItems={[
					{
						avatar: <Logo className="size-8" withLabel={false} />,
						title: t("title"),
						items: [
							{
								title: t("menu.analytics"),
								href: "/admin/analytics",
								icon: <BarChart3Icon className="size-4 opacity-50" />,
							},
							{
								title: t("menu.payments"),
								href: "/admin/payments",
								icon: <CreditCardIcon className="size-4 opacity-50" />,
							},
							{
								title: t("menu.support"),
								href: "/admin/support",
								icon: <LifeBuoyIcon className="size-4 opacity-50" />,
							},
							{
								title: t("menu.notifications"),
								href: "/admin/notifications",
								icon: <BellRingIcon className="size-4 opacity-50" />,
							},
							{
								title: t("menu.agent"),
								href: "/admin/agent",
								icon: <BotIcon className="size-4 opacity-50" />,
							},
							{
								title: t("menu.users"),
								href: "/admin/users",
								icon: <UsersIcon className="size-4 opacity-50" />,
							},
							{
								title: t("menu.media"),
								href: "/admin/media",
								icon: <ActivityIcon className="size-4 opacity-50" />,
							},
							...(config.organizations.enable
								? [
										{
											title: t("menu.organizations"),
											href: "/admin/organizations",
											icon: <Building2Icon className="size-4 opacity-50" />,
										},
									]
								: []),
						],
					},
				]}
			/>

			{children}
		</AdminMessagesProvider>
	);
}
