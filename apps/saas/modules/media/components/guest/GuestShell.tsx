"use client";

import { Button } from "@repo/ui/components/button";
import { Logo } from "@repo/ui/components/logo";
import { useTranslations } from "next-intl";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

type GuestLinkDestination = "login" | "signup";
type GuestLinkHandler = (destination: GuestLinkDestination) => void;

const GuestLinkContext = createContext<{
	setLinkHandler: (handler: GuestLinkHandler | null) => void;
}>({ setLinkHandler: () => undefined });

export function GuestShell({ children }: PropsWithChildren) {
	const t = useTranslations("media.guest.nav");
	const [linkHandler, setLinkHandlerState] = useState<GuestLinkHandler | null>(null);
	const setLinkHandler = useCallback((handler: GuestLinkHandler | null) => {
		setLinkHandlerState(() => handler);
	}, []);
	const context = useMemo(() => ({ setLinkHandler }), [setLinkHandler]);

	return (
		<GuestLinkContext.Provider value={context}>
			<div className="text-slate-950 min-h-screen bg-[radial-gradient(circle_at_top,#ede9fe_0,transparent_34rem),linear-gradient(180deg,#f8fafc,#fff)]">
				<header className="border-violet-100 bg-white/80 backdrop-blur-xl border-b">
					<div className="min-h-16 gap-4 px-4 sm:px-6 lg:px-8 mx-auto flex max-w-[90rem] items-center justify-between">
						<Logo label="EzPic" className="text-slate-950" />
						<nav aria-label={t("brand")} className="gap-2 flex items-center">
							<Button
								type="button"
								variant="ghost"
								className="min-h-11"
								disabled={!linkHandler}
								onClick={() => linkHandler?.("login")}
							>
								{t("signIn")}
							</Button>
							<Button
								type="button"
								variant="primary"
								className="min-h-11 bg-indigo-600 hover:bg-indigo-700"
								disabled={!linkHandler}
								onClick={() => linkHandler?.("signup")}
							>
								{t("createAccount")}
							</Button>
						</nav>
					</div>
				</header>
				<main>{children}</main>
			</div>
		</GuestLinkContext.Provider>
	);
}

export function useGuestShellLinking(linkHandler: GuestLinkHandler) {
	const context = useContext(GuestLinkContext);
	return { setLinkHandler: context.setLinkHandler, linkHandler };
}
