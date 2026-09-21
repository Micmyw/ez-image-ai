"use client";

import { useSessionQuery } from "@auth/lib/api";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";

import { HeaderNavigationMenu } from "./HeaderNavigationMenu";
import { HeaderPurchaseActions } from "./HeaderPurchaseActions";

import "./studio.css";

const UserMenu = dynamic(() => import("../UserMenu").then((module) => module.UserMenu));
const NotificationCenter = dynamic(() =>
	import("../NotificationCenter").then((module) => module.NotificationCenter),
);
const SessionProvider = dynamic(() =>
	import("@auth/components/SessionProvider").then((module) => module.SessionProvider),
);

export function PublicHeaderAccount() {
	const { data: session } = useSessionQuery();
	const t = useTranslations("common.menu");
	const registered = Boolean(session?.user && session.user.isAnonymous !== true);
	return (
		<div className="studio-header-account">
			<HeaderPurchaseActions registered={registered} />
			{registered ? (
				<SessionProvider>
					<div className="studio-header-user-controls">
						<UserMenu studio />
					</div>
					<HeaderNavigationMenu
						registered
						admin={session?.user.role === "admin"}
						account={
							<>
								<UserMenu showUserName studio />
								<NotificationCenter />
							</>
						}
					/>
				</SessionProvider>
			) : (
				<>
					{/* Account routes read the saved locale in a fresh root layout. */}
					<a className="text-sm text-violet-200 whitespace-nowrap" href="/login">
						{t("login")}
					</a>
					<HeaderNavigationMenu registered={false} />
				</>
			)}
		</div>
	);
}
