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
					<div className="min-h-16 gap-2 px-4 sm:gap-4 sm:px-6 lg:px-8 mx-auto flex max-w-[90rem] items-center justify-between">
						<div className="flex shrink-0 items-center">
							<Logo label="EzPic" withLabel={false} decorative className="text-slate-950" />
							<span className="ml-2 text-base font-semibold text-slate-950 sm:text-lg leading-none">
								EzPic
							</span>
						</div>
						<nav aria-label={t("brand")} className="min-w-0 gap-1 sm:gap-2 flex items-center">
							<Button
								type="button"
								variant="ghost"
								className="min-h-11 px-2 text-xs sm:px-4 sm:text-sm"
								disabled={!linkHandler}
								onClick={() => linkHandler?.("login")}
							>
								{t("signIn")}
							</Button>
							<Button
								type="button"
								variant="primary"
								className="min-h-11 bg-indigo-600 px-2 text-xs hover:bg-indigo-700 sm:px-4 sm:text-sm"
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
