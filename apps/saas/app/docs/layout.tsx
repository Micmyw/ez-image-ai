import { DocsHeader } from "@docs/components/DocsHeader";
import { source } from "@docs/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import Link from "next/link";

import "./docs.css";

export default function DocumentationLayout({ children }: LayoutProps<"/docs">) {
	return (
		<div id="docs-root" lang="en">
			<a className="docs-skip-link" href="#docs-content">
				Skip to content
			</a>
			<RootProvider theme={{ enabled: false }} search={{ options: { api: "/docs/api/search" } }}>
				<DocsLayout
					tree={source.getPageTree()}
					tabs={false}
					themeSwitch={{ enabled: false }}
					slots={{ header: DocsHeader }}
					containerProps={{
						style: {
							gridTemplate:
								'"header header header header header" auto "sidebar sidebar toc-popover toc toc" auto "sidebar sidebar main toc toc" 1fr / minmax(0, 1fr) var(--fd-sidebar-col) minmax(0, calc(var(--fd-layout-width) - var(--fd-sidebar-width) - var(--fd-toc-width))) var(--fd-toc-width) minmax(0, 1fr)',
						},
					}}
					nav={{
						title: <span className="docs-nav-caption">Help center</span>,
						url: "/docs",
					}}
					sidebar={{
						collapsible: false,
						footer: (
							<div className="docs-sidebar-footer">
								<p>Ready to try it?</p>
								<Link href="/create">
									Open the image editor <span aria-hidden>↗</span>
								</Link>
								<nav aria-label="More from EzImageAI">
									<Link href="/blog">Blog</Link>
									<Link href="/examples">Editing Examples</Link>
									<Link href="/pricing">Pricing</Link>
									<Link href="/contact">Support</Link>
								</nav>
							</div>
						),
					}}
				>
					{children}
				</DocsLayout>
			</RootProvider>
		</div>
	);
}
