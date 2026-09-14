"use client";

import { ImageModelIcon } from "@media/components/ImageModelIcon";
import { imageModelHref } from "@media/hooks/use-model-navigation";
import { isEditorProductKey } from "@media/lib/editor-recovery";
import { publicCatalogQueryOptions } from "@media/lib/public-catalog-query";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ImagesIcon, LayoutGridIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

export function StudioToolNavigation({
	sidebar = false,
	onNavigate,
}: {
	sidebar?: boolean;
	onNavigate?: () => void;
}) {
	const t = useTranslations("studio.tools");
	const models = useTranslations("media.create.products");
	const pathname = usePathname();
	const selected =
		useSearchParams().get("model") ??
		(pathname.startsWith("/models/") ? `image-${pathname.slice("/models/".length)}` : null);
	const [menu, setMenu] = useState<"tools" | "models" | null>(null);
	const catalog = useQuery(publicCatalogQueryOptions);
	const products = (catalog.data?.products ?? []).filter(
		(product) => isEditorProductKey(product.key) && product.skuMatrix?.cells.length,
	);
	const navigate = () => {
		setMenu(null);
		onNavigate?.();
	};
	const tools = (
		<>
			<Link
				href="/create"
				onClick={navigate}
				className={sidebar ? "studio-nav-link" : "studio-menu-entry"}
				aria-current={pathname === "/create" && !selected ? "page" : undefined}
			>
				<ImagesIcon aria-hidden />
				<span>
					<strong>{t("imageToImage")}</strong>
					{!sidebar && <small>{t("imageToImageDescription")}</small>}
				</span>
			</Link>
			<Link
				href="/create#examples"
				onClick={navigate}
				className={sidebar ? "studio-nav-link" : "studio-menu-entry"}
			>
				<LayoutGridIcon aria-hidden />
				<span>
					<strong>{t("examples")}</strong>
					{!sidebar && <small>{t("examplesDescription")}</small>}
				</span>
			</Link>
		</>
	);
	const modelLinks = products.map((product) => {
		return (
			<Link
				key={product.key}
				href={
					sidebar && pathname === "/create"
						? `/create?model=${encodeURIComponent(product.key)}`
						: imageModelHref(product.key)
				}
				scroll={false}
				onClick={navigate}
				className={
					sidebar
						? `studio-nav-link${selected === product.key ? " is-active" : ""}`
						: "studio-menu-entry"
				}
				aria-current={selected === product.key ? "page" : undefined}
			>
				<span className={sidebar ? "studio-nav-model-icon" : "studio-menu-model-icon"}>
					<ImageModelIcon productKey={product.key} size={sidebar ? 18 : 24} />
				</span>
				<span>
					<strong>{models(`${product.key}.label`)}</strong>
					{!sidebar && <small>{models(`${product.key}.description`)}</small>}
				</span>
			</Link>
		);
	});
	const modelContent = modelLinks.length ? (
		modelLinks
	) : (
		<output className="studio-menu-status">
			{catalog.isPending ? t("loading") : t("unavailable")}
		</output>
	);
	if (sidebar)
		return (
			<div className="studio-tool-sidebar">
				<p className="studio-nav-label">{t("imageTools")}</p>
				{tools}
				<Link href="/models" className="studio-nav-label">
					{t("models")}
				</Link>
				{modelContent}
			</div>
		);
	return (
		<>
			{(["tools", "models"] as const).map((kind) => (
				<Popover
					key={kind}
					open={menu === kind}
					onOpenChange={(open) => setMenu(open ? kind : null)}
				>
					<PopoverTrigger
						render={
							<button
								type="button"
								className="studio-menu-trigger"
								data-test={`studio-${kind}-menu`}
							>
								{t(kind === "tools" ? "imageTools" : "models")}
								<ChevronDownIcon aria-hidden />
							</button>
						}
					/>
					<PopoverContent
						align="start"
						sideOffset={12}
						positionerClassName="z-[70]"
						className={`studio-theme studio-navigation-popover ${kind === "models" ? "studio-model-popover" : ""}`}
						aria-label={t(kind === "tools" ? "imageTools" : "models")}
					>
						<div className={kind === "models" ? "studio-model-grid" : undefined}>
							{kind === "tools" ? tools : modelContent}
						</div>
						{kind === "models" && (
							<Link href="/models" className="studio-menu-entry" onClick={navigate}>
								{t("models")} <span aria-hidden>→</span>
							</Link>
						)}
					</PopoverContent>
				</Popover>
			))}
		</>
	);
}
