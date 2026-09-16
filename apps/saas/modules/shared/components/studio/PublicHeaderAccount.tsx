"use client";

import { useSessionQuery } from "@auth/lib/api";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import Link from "next/link";

import { HeaderPurchaseActions } from "./HeaderPurchaseActions";

import "./studio.css";

const UserMenu = dynamic(() => import("../UserMenu").then((module) => module.UserMenu));
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
					<UserMenu studio />
				</SessionProvider>
			) : (
				<Link className="text-sm text-violet-200 whitespace-nowrap" href="/login">
					{t("login")}
				</Link>
			)}
		</div>
	);
}
