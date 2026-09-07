import { getPublicConfig } from "@repo/config/client";
import { Logo } from "@repo/ui/components/logo";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";

import { PublicFooterLinks } from "./PublicFooterLinks";

export function PublicPageShell({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	const t = useTranslations();
	const publicConfig = getPublicConfig();

	return (
		<div className="min-h-screen bg-[#100d1b] text-[#f7f3ff]">
			<header className="top-0 border-white/10 backdrop-blur-xl sticky z-50 border-b bg-[#100d1b]/90">
				<div className="min-h-16 gap-4 container flex items-center">
					<Link
						href="/"
						className="focus-visible:outline-violet-300 shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
						aria-label={publicConfig.brand.siteName}
					>
						<Logo
							className="text-white [&_svg]:text-violet-400"
							label={publicConfig.brand.siteName}
						/>
					</Link>
					<nav className="gap-1 text-sm font-medium text-slate-300 ml-auto flex items-center">
						<Link className="px-3 py-2 hover:text-white" href="/pricing">
							{t("common.menu.pricing")}
						</Link>
						<Link className="px-3 py-2 hover:text-white sm:inline hidden" href="/blog">
							{t("common.menu.blog")}
						</Link>
						<Link className="px-3 py-2 hover:text-white sm:inline hidden" href="/docs">
							{t("common.menu.docs")}
						</Link>
						<Link
							className="min-h-11 px-4 font-semibold text-white inline-flex items-center rounded-xl bg-[#6c4dff] hover:bg-[#7d63ff]"
							href="/login"
						>
							{t("common.menu.login")}
						</Link>
					</nav>
				</div>
			</header>

			<main className="py-14 sm:py-20">
				<div className="container">
					<div className="max-w-3xl mx-auto text-center">
						<h1 className="text-4xl font-semibold text-white sm:text-5xl tracking-[-0.04em] text-balance">
							{title}
						</h1>
						<p className="mt-4 text-base leading-7 text-slate-300 sm:text-lg text-balance">
							{description}
						</p>
					</div>
					<div className="mt-12">{children}</div>
				</div>
			</main>

			<footer className="py-8 border-t border-[#2c2440] bg-[#0c0914]">
				<div className="gap-5 sm:flex-row sm:text-left container flex flex-col items-center justify-between text-center">
					<div>
						<Logo
							className="text-white [&_svg]:text-violet-400"
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
