"use client";

import { MenuIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ComponentProps, Suspense, lazy, useState } from "react";

const NavigationMenu = lazy(() =>
	import("./HeaderNavigationMenu").then((module) => ({ default: module.HeaderNavigationMenu })),
);

/** The compact navigation needs its drawer only after the visitor opens it. */
export function DeferredHeaderNavigationMenu(props: ComponentProps<typeof NavigationMenu>) {
	const t = useTranslations("studio");
	const [requested, setRequested] = useState(false);
	const [localOpen, setLocalOpen] = useState(false);
	const open = props.open ?? localOpen;
	const setOpen = props.onOpenChange ?? setLocalOpen;
	const trigger = (
		<button
			type="button"
			ref={props.triggerRef}
			className="studio-header-menu-trigger"
			data-test="header-navigation-trigger"
			aria-label={t("openNavigation")}
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-busy={requested || undefined}
			onClick={() => {
				setOpen(true);
				setRequested(true);
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") setOpen(false);
			}}
		>
			<MenuIcon aria-hidden />
		</button>
	);
	return requested || open ? (
		<Suspense fallback={trigger}>
			<NavigationMenu {...props} open={open} onOpenChange={setOpen} />
		</Suspense>
	) : (
		trigger
	);
}
