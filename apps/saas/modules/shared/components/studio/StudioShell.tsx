"use client";

import { SessionProvider } from "@auth/components/SessionProvider";
import { useSession } from "@auth/hooks/use-session";
import { OrganzationSelect } from "@organizations/components/OrganizationSelect";
import { config as authConfig } from "@repo/auth/config";
import { Button } from "@repo/ui/components/button";
import { Logo } from "@repo/ui/components/logo";
import { useIsMobile } from "@shared/hooks/use-media-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import {
	BookOpenIcon,
	CoinsIcon,
	HistoryIcon,
	ImagesIcon,
	MenuIcon,
	SparklesIcon,
	XIcon,
	ShieldUserIcon,
	LayoutGridIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { NotificationCenter } from "../NotificationCenter";
import { UserMenu } from "../UserMenu";
import { StudioContext, studioPanelForPath, type StudioPanel } from "./studio-context";
import { StudioPanelBoundary } from "./StudioPanelBoundary";
import { StudioToolNavigation } from "./StudioToolNavigation";

import "./studio.css";

const StudioPanels = dynamic(() => import("./StudioPanels").then((module) => module.StudioPanels));

export function StudioShell({ children }: { children: ReactNode }) {
	return (
		<SessionProvider>
			<StudioShellContent>{children}</StudioShellContent>
		</SessionProvider>
	);
}

function StudioShellContent({ children }: { children: ReactNode }) {
	const t = useTranslations("studio");
	const common = useTranslations("common.menu");
	const { user } = useSession();
	const registered = Boolean(user && user.isAnonymous !== true);
	const pathname = usePathname();
	const showSidebar = pathname === "/create" || (registered && pathname !== "/");
	const mobile = useIsMobile();
	const editing = pathname === "/" || pathname === "/create";
	const [panel, setPanel] = useState<StudioPanel | null>(null);
	const [navigationOpen, setNavigationOpen] = useState(false);
	const navigationVisible = showSidebar && navigationOpen;
	const opener = useRef<HTMLElement | null>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const navigationRef = useRef<HTMLElement>(null);
	const navigationTrigger = useRef<HTMLButtonElement>(null);
	const panelActive = useRef(false);
	const closeNavigation = useCallback(() => {
		setNavigationOpen(false);
		requestAnimationFrame(() => navigationTrigger.current?.focus({ preventScroll: true }));
	}, []);
	const openPanel = useCallback(
		(next: StudioPanel) => {
			if (!panelActive.current)
				opener.current =
					mobile && navigationVisible
						? navigationTrigger.current
						: document.activeElement instanceof HTMLElement
							? document.activeElement
							: null;
			panelActive.current = true;
			setPanel(next);
			setNavigationOpen(false);
		},
		[mobile, navigationVisible],
	);
	const closePanel = useCallback(() => {
		setPanel(null);
		panelActive.current = false;
		requestAnimationFrame(
			() => opener.current?.isConnected && opener.current.focus({ preventScroll: true }),
		);
	}, []);
	useEffect(() => {
		if (panel) closeRef.current?.focus({ preventScroll: true });
	}, [panel]);
	useEffect(() => {
		setNavigationOpen(false);
	}, [pathname]);
	useEffect(() => {
		function escape(event: KeyboardEvent) {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (panel) closePanel();
			else if (navigationVisible) closeNavigation();
		}
		document.addEventListener("keydown", escape);
		return () => document.removeEventListener("keydown", escape);
	}, [panel, closePanel, navigationVisible, closeNavigation]);
	function intercept(event: MouseEvent<HTMLDivElement>) {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		)
			return;
		const anchor = (event.target as Element).closest("a");
		if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
		if (anchor.closest("[data-studio-menu]")) return;
		const url = new URL(anchor.href, window.location.href);
		if (url.origin !== window.location.origin) return;
		const next = studioPanelForPath(url.pathname);
		if (registered && next && editing && url.searchParams.get("full") !== "true") {
			event.preventDefault();
			openPanel(next);
		} else if (pathname === "/" && url.pathname === "/" && !url.search && !url.hash) {
			event.preventDefault();
			document.getElementById("image-editor")?.scrollIntoView({ behavior: "smooth" });
		}
		setNavigationOpen(false);
	}

	useEffect(() => {
		if (!mobile || (!panel && !navigationVisible)) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const region = panel ? panelRef.current : navigationRef.current;
		if (navigationVisible) region?.querySelector<HTMLElement>("a, button")?.focus();
		function containFocus(event: KeyboardEvent) {
			if (event.key !== "Tab" || event.defaultPrevented || !region) return;
			const focusable = Array.from(
				region.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
				),
			).filter((element) => element.getClientRects().length > 0);
			const first = focusable[0],
				last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		}
		document.addEventListener("keydown", containFocus);
		return () => {
			document.body.style.overflow = previousOverflow;
			document.removeEventListener("keydown", containFocus);
		};
	}, [mobile, panel, navigationVisible]);
	const sectionHref = (hash: string) => (editing ? hash : "/" + hash);
	const sidebar = (
		<>
			<div className="studio-brand-row">
				<Link href="/" aria-label="EzPic">
					<Logo className="text-white [&_svg]:text-violet-300" label="EzPic" />
				</Link>
				<button
					className="studio-icon studio-mobile-only"
					onClick={closeNavigation}
					aria-label={t("closeNavigation")}
				>
					<XIcon />
				</button>
			</div>
			<nav className="studio-navigation" aria-label={t("navigation")}>
				<Link
					className={editing ? "studio-nav-link is-active" : "studio-nav-link"}
					href={editing ? "#image-editor" : "/create"}
				>
					<SparklesIcon />
					{t("create")}
				</Link>
				<StudioToolNavigation sidebar onNavigate={() => setNavigationOpen(false)} />
				<a className="studio-nav-link" href={sectionHref("#examples")}>
					<LayoutGridIcon />
					{t("explore")}
				</a>
				{registered && (
					<>
						<p className="studio-nav-label">{t("workspace")}</p>
						<Link className="studio-nav-link" href="/history">
							<HistoryIcon />
							{t("history")}
						</Link>
						<Link className="studio-nav-link" href="/assets">
							<ImagesIcon />
							{t("assets")}
						</Link>
						<Link className="studio-nav-link" href="/edits">
							<ImagesIcon />
							{t("edits")}
						</Link>
					</>
				)}
				<p className="studio-nav-label">{t("discover")}</p>
				<a className="studio-nav-link" href={sectionHref("#how-it-works")}>
					<BookOpenIcon />
					{common("howItWorks")}
				</a>
				<a className="studio-nav-link" href={sectionHref("#pricing")}>
					<CoinsIcon />
					{common("pricing")}
				</a>
				{user?.role === "admin" && (
					<Link className="studio-nav-link" href="/admin">
						<ShieldUserIcon />
						{t("admin")}
					</Link>
				)}
			</nav>
			<div className="studio-account">
				{registered ? (
					<>
						{authConfig.organizations.enable && !authConfig.organizations.hideOrganization && (
							<OrganzationSelect className="mb-3 w-full" />
						)}
						<StudioCredits onClick={() => openPanel({ kind: "billing" })} />
						<UserMenu showUserName studio />
					</>
				) : (
					<Link className="studio-signin" href="/login">
						{common("login")}
						<span aria-hidden>↗</span>
					</Link>
				)}
			</div>
		</>
	);
	return (
		<StudioContext.Provider value={{ openPanel, closePanel }}>
			<div
				className="studio-shell"
				data-studio-shell=""
				data-workspace={showSidebar}
				data-panel-open={Boolean(panel)}
				onClickCapture={intercept}
			>
				{showSidebar && (
					<aside
						ref={navigationRef}
						className="studio-sidebar"
						data-open={navigationVisible}
						inert={mobile && Boolean(panel)}
					>
						{sidebar}
					</aside>
				)}
				{navigationVisible && (
					<button
						className="studio-nav-backdrop"
						aria-label={t("closeNavigation")}
						onClick={closeNavigation}
					/>
				)}
				<div className="studio-main" inert={mobile && Boolean(panel || navigationVisible)}>
					<header className="studio-topbar">
						<div className="min-w-0 gap-3 flex items-center">
							{showSidebar ? (
								<>
									<button
										className="studio-icon studio-mobile-only"
										ref={navigationTrigger}
										aria-expanded={navigationVisible}
										aria-label={t("openNavigation")}
										onClick={() => setNavigationOpen(true)}
									>
										<MenuIcon />
									</button>
									<span className="text-xs truncate text-[#b7acbf]">{t("create")}</span>
								</>
							) : (
								<Link href="/" aria-label="EzPic" className="shrink-0 rounded-lg">
									<Logo className="text-white [&_svg]:text-violet-300" label="EzPic" />
								</Link>
							)}
						</div>
						<nav className="studio-toplinks" aria-label={t("pageNavigation")}>
							<StudioToolNavigation />
							<a href={sectionHref("#pricing")}>{common("pricing")}</a>
						</nav>
						{registered ? (
							<div className="gap-3 flex items-center">
								{!showSidebar && (
									<Link href="/create" className="studio-create-link">
										{t("create")}
									</Link>
								)}
								<NotificationCenter />
								<div className={showSidebar ? "studio-mobile-only" : undefined}>
									<UserMenu studio />
								</div>
							</div>
						) : (
							<Link className="text-sm text-violet-200" href="/login">
								{common("login")}
							</Link>
						)}
					</header>
					{children}
				</div>
				{panel && registered && (
					<aside
						ref={panelRef}
						className="studio-panel"
						role={mobile ? "dialog" : "region"}
						aria-modal={mobile ? true : undefined}
						aria-labelledby="studio-panel-title"
					>
						<header className="studio-panel-header">
							<h2 id="studio-panel-title">{t(`panels.${panel.kind}`)}</h2>
							<button
								ref={closeRef}
								className="studio-icon"
								aria-label={t("closePanel")}
								onClick={closePanel}
							>
								<XIcon />
							</button>
						</header>
						<p className="mb-6 text-xs leading-6 text-muted-foreground">{t("panelHint")}</p>
						{["general", "security", "notifications"].includes(panel.kind) && (
							<nav className="mb-6 gap-2 flex flex-wrap" aria-label={t("panels.general")}>
								{(["general", "security", "notifications"] as const).map((kind) => (
									<Button
										key={kind}
										size="sm"
										variant={panel.kind === kind ? "primary" : "secondary"}
										aria-current={panel.kind === kind ? "page" : undefined}
										onClick={() => openPanel({ kind })}
									>
										{t(`panels.${kind}`)}
									</Button>
								))}
							</nav>
						)}
						<StudioPanelBoundary key={panel.kind} errorLabel={t("error")} retryLabel={t("retry")}>
							<StudioPanels panel={panel} onChange={openPanel} onClose={closePanel} />
						</StudioPanelBoundary>
					</aside>
				)}
			</div>
		</StudioContext.Provider>
	);
}

function StudioCredits({ onClick }: { onClick: () => void }) {
	const t = useTranslations("studio");
	const account = useQuery({
		queryKey: ["media-credit-account"],
		queryFn: () => orpcClient.media.getCreditAccount(),
	});
	return (
		<button className="studio-credit-link" onClick={onClick} aria-label={t("credits")}>
			<CoinsIcon />
			<span className="!ml-0">
				{account.data
					? t("creditBalance", { credits: account.data.spendableCredits })
					: t("credits")}
			</span>
			<span aria-hidden>↗</span>
		</button>
	);
}
