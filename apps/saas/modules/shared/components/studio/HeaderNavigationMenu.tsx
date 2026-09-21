"use client";

import { Logo } from "@repo/ui/components/logo";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@repo/ui/components/sheet";
import { useMediaQuery } from "@shared/hooks/use-media-query";
import { ArrowUpRightIcon, MenuIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	type MouseEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";

import { HeaderPurchaseActions } from "./HeaderPurchaseActions";
import { StudioToolNavigation } from "./StudioToolNavigation";

export function HeaderNavigationMenu({
	registered,
	account,
	admin = false,
	pricingHref = "/pricing",
	open: controlledOpen,
	onOpenChange,
	triggerRef,
	restoreFocus = true,
}: {
	registered: boolean;
	account?: ReactNode;
	admin?: boolean;
	pricingHref?: string;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	triggerRef?: RefObject<HTMLButtonElement | null>;
	restoreFocus?: boolean;
}) {
	const t = useTranslations("studio");
	const common = useTranslations("common.menu");
	const pathname = usePathname();
	const compact = useMediaQuery("(max-width: 1200px)");
	const [localOpen, setLocalOpen] = useState(false);
	const localTrigger = useRef<HTMLButtonElement>(null);
	const returnFocus = useRef(true);
	const trigger = triggerRef ?? localTrigger;
	const open = controlledOpen ?? localOpen;
	const setOpen = onOpenChange ?? setLocalOpen;

	useEffect(() => {
		setOpen(false);
	}, [pathname, setOpen]);
	useEffect(() => {
		if (!compact) setOpen(false);
	}, [compact, setOpen]);

	function navigate(event: MouseEvent<HTMLDivElement>) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		const anchor = (event.target as Element).closest("a[href]");
		if (!anchor || anchor.hasAttribute("target") || anchor.hasAttribute("download")) return;
		// Navigation and newly opened account/payment panels manage their own focus.
		returnFocus.current = false;
		setOpen(false);
	}

	return (
		<Sheet
			open={open}
			onOpenChange={(next) => {
				if (next) returnFocus.current = true;
				setOpen(next);
			}}
		>
			<SheetTrigger
				ref={trigger}
				render={
					<button
						type="button"
						className="studio-header-menu-trigger"
						data-test="header-navigation-trigger"
						aria-label={t("openNavigation")}
					>
						<MenuIcon aria-hidden />
					</button>
				}
			/>
			<SheetContent
				className="studio-theme studio-header-drawer"
				data-test="header-navigation-drawer"
				finalFocus={() =>
					restoreFocus && returnFocus.current && compact ? trigger.current : false
				}
				onClick={navigate}
			>
				<SheetTitle className="sr-only">{t("pageNavigation")}</SheetTitle>
				<Link href="/" aria-label="EzImageAI" className="studio-drawer-brand">
					<Logo className="studio-header-brand" label="EzImageAI" />
				</Link>
				<nav className="studio-drawer-navigation" aria-label={t("pageNavigation")}>
					<Link href="/create" className="studio-drawer-create">
						{t("create")} <ArrowUpRightIcon aria-hidden />
					</Link>
					<StudioToolNavigation drawer />
					<div className="studio-drawer-link-group">
						<Link href={pricingHref}>{common("pricing")}</Link>
						<Link href="/blog">{common("blog")}</Link>
						<Link href="/docs">{common("docs")}</Link>
					</div>
					{registered && (
						<div className="studio-drawer-link-group">
							<p className="studio-drawer-label">{t("workspace")}</p>
							<Link href="/history">{t("history")}</Link>
							<Link href="/assets">{t("assets")}</Link>
							<Link href="/edits">{t("edits")}</Link>
							{admin && <Link href="/admin">{t("admin")}</Link>}
						</div>
					)}
				</nav>
				<div className="studio-drawer-account">
					<HeaderPurchaseActions registered={registered} showCredits={false} />
					{registered ? (
						<div className="studio-drawer-user">{account}</div>
					) : (
						<a href="/login" className="studio-drawer-signin">
							{common("login")} <ArrowUpRightIcon aria-hidden />
						</a>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
