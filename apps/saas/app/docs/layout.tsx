import { source } from "@docs/lib/source";
import { Logo } from "@repo/ui/components/logo";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";

import "./docs.css";

export default function DocumentationLayout({ children }: LayoutProps<"/docs">) {
	return (
		<div id="docs-root" lang="en" className="min-h-screen">
			<RootProvider theme={{ enabled: false }} search={{ options: { api: "/docs/api/search" } }}>
				<DocsLayout
					tree={source.getPageTree()}
					nav={{
						title: <Logo />,
						url: "/",
					}}
				>
					{children}
				</DocsLayout>
			</RootProvider>
		</div>
	);
}
