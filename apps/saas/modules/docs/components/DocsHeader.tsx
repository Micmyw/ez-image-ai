"use client";

import { getPublicConfig } from "@repo/config/client";
import { Logo } from "@repo/ui/components/logo";
import { useDocsLayout } from "fumadocs-ui/layouts/docs";
import { ArrowUpRight, Menu } from "lucide-react";
import Link from "next/link";

export function DocsHeader() {
	const { slots } = useDocsLayout();
	const { brand } = getPublicConfig();

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
				<Link href="/models">Models</Link>
				<Link href="/effects">Effects</Link>
				<Link href="/blog">Guides</Link>
				<Link href="/pricing">Pricing</Link>
			</nav>
			<div className="docs-header-actions">
				{slots.searchTrigger && <slots.searchTrigger.sm className="docs-icon-button" />}
				<Link className="docs-open-editor" href="/create">
					Open editor <ArrowUpRight aria-hidden />
				</Link>
				<slots.sidebar.trigger
					className="docs-icon-button docs-menu-button"
					aria-label="Open documentation navigation"
				>
					<Menu aria-hidden />
				</slots.sidebar.trigger>
			</div>
		</header>
	);
}
