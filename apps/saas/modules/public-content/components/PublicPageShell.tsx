import { getPublicConfig } from "@repo/config/client";
import { Logo } from "@repo/ui/components/logo";
import { PublicHeaderAccount } from "@shared/components/studio/PublicHeaderAccount";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";

import { PublicFooterLinks } from "./PublicFooterLinks";

export function PublicPageShell({
	title,
	description,
	children,
	eyebrow,
	headingMeta,
	compact = false,
}: {
	title: string;
	description: string;
	children: ReactNode;
	eyebrow?: ReactNode;
	headingMeta?: ReactNode;
	compact?: boolean;
}) {
	const t = useTranslations();
	const publicConfig = getPublicConfig();

	return (
		<div
			className="min-h-screen bg-[#100d1b] text-[#f7f3ff]"
			data-public-layout={compact ? "compact" : undefined}
		>
			<header className="top-0 border-white/10 backdrop-blur-xl sticky z-50 border-b bg-[#100d1b]/90">
				<div className="studio-public-topbar container">
					<Link
						href="/"
						className="focus-visible:outline-violet-300 shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
						aria-label={publicConfig.brand.siteName}
					>
						<Logo className="studio-header-brand" label={publicConfig.brand.siteName} />
					</Link>
					<nav
						className="studio-public-toplinks sm:flex hidden"
						aria-label={t("studio.pageNavigation")}
					>
						<Link className="px-3 py-2 hover:text-white" href="/effects">
							{t("effects.name")}
						</Link>
						<Link className="px-3 py-2 hover:text-white" href="/pricing">
							{t("common.menu.pricing")}
						</Link>
						<Link className="px-3 py-2 hover:text-white sm:inline hidden" href="/blog">
							{t("common.menu.blog")}
						</Link>
						<Link className="px-3 py-2 hover:text-white sm:inline hidden" href="/docs">
							{t("common.menu.docs")}
						</Link>
					</nav>
					<PublicHeaderAccount />
				</div>
				{!compact && (
					<nav
						className="gap-x-5 border-white/5 text-sm sm:hidden container flex flex-wrap justify-center border-t"
						aria-label={t("studio.pageNavigation")}
					>
						<Link className="min-h-11 text-violet-200 inline-flex items-center" href="/effects">
							{t("effects.name")}
						</Link>
						<Link className="min-h-11 inline-flex items-center" href="/blog">
							{t("common.menu.blog")}
						</Link>
						<Link className="min-h-11 inline-flex items-center" href="/pricing">
							{t("common.menu.pricing")}
						</Link>
						<Link className="min-h-11 inline-flex items-center" href="/docs">
							{t("common.menu.docs")}
						</Link>
					</nav>
				)}
			</header>

			<main className={compact ? "py-8 sm:py-12" : "py-14 sm:py-20"}>
				<div className="container">
					<div className="max-w-3xl mx-auto text-center">
						{eyebrow && (
							<div className={`${compact ? "mb-3" : "mb-5"} text-sm text-violet-200`}>
								{eyebrow}
							</div>
						)}
						<h1
							className={`${compact ? "text-3xl sm:text-4xl" : "text-4xl sm:text-5xl"} font-semibold text-white tracking-[-0.04em] text-balance`}
						>
							{title}
						</h1>
						<p className="mt-4 text-base leading-7 text-slate-300 sm:text-lg text-balance">
							{description}
						</p>
						{headingMeta && <div className="mt-6 text-sm text-slate-400">{headingMeta}</div>}
					</div>
					<div className={compact ? "mt-6" : "mt-12"}>{children}</div>
				</div>
			</main>

			<footer className="py-8 border-t border-[#2c2440] bg-[#0c0914]">
				<div className="gap-5 sm:flex-row sm:text-left container flex flex-col items-center justify-between text-center">
					<div>
						<Logo
							className="text-white [&_svg]:text-violet-400 [&>span]:block"
							label={publicConfig.brand.siteName}
						/>
						<p className="mt-2 max-w-md text-xs leading-5 text-slate-400">
							{publicConfig.brand.siteDescription}
						</p>
					</div>
					<PublicFooterLinks className="gap-x-4 gap-y-2 text-sm font-medium text-slate-300 flex flex-wrap items-center justify-center" />
				</div>
			</footer>
		</div>
	);
}
