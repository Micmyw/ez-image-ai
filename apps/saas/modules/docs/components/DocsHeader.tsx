"use client";

import { getPublicConfig } from "@repo/config/client";
import { Logo } from "@repo/ui/components/logo";
import { HeaderNavigationMenu } from "@shared/components/studio/HeaderNavigationMenu";
import { StudioToolNavigation } from "@shared/components/studio/StudioToolNavigation";
import { useDocsLayout } from "fumadocs-ui/layouts/docs";
import { ArrowUpRight, PanelLeftIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

import "@shared/components/studio/studio.css";

export function DocsHeader() {
	const { slots } = useDocsLayout();
	const { brand } = getPublicConfig();
	const t = useTranslations("common.menu");

	return (
		<header id="nd-subnav" className="docs-product-header">
			<Link className="docs-brand" href="/" aria-label={brand.siteName}>
				<Logo label={brand.siteName} />
			</Link>
			<span className="docs-header-divider" aria-hidden />
			<Link className="docs-header-label" href="/docs">
				Docs
			</Link>
			<nav className="docs-product-links" aria-label="EzImageAI navigation">
				<StudioToolNavigation />
				<Link href="/pricing">{t("pricing")}</Link>
			</nav>
			<div className="docs-header-actions">
				{slots.searchTrigger && <slots.searchTrigger.sm className="docs-icon-button" />}
				<Link className="docs-open-editor" href="/create">
					Open editor <ArrowUpRight aria-hidden />
				</Link>
				<HeaderNavigationMenu registered={false} showAccountActions={false} />
				<slots.sidebar.trigger
					className="docs-icon-button docs-menu-button"
					aria-label="Open documentation navigation"
				>
					<PanelLeftIcon aria-hidden />
				</slots.sidebar.trigger>
			</div>
		</header>
	);
}
