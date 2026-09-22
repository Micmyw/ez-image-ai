"use client";

import { ImageModelIcon } from "@media/components/ImageModelIcon";
import { imageModelHref, useRequestedImageModel } from "@media/hooks/use-model-navigation";
import { DEFAULT_EDITOR_PRODUCT_KEY, isEditorProductKey } from "@media/lib/editor-recovery";
import { publicCatalogQueryOptions } from "@media/lib/public-catalog-query";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ImagesIcon, LayoutGridIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type MouseEvent, useState } from "react";

import { resetStudioWorkspace } from "./studio-context";

export function StudioToolNavigation({
	sidebar = false,
	drawer = false,
	onNavigate,
}: {
	sidebar?: boolean;
	drawer?: boolean;
	onNavigate?: () => void;
}) {
	const t = useTranslations("studio.tools");
	const imageToImage = useTranslations("imageToImage");
	const vertical = sidebar || drawer;
	const models = useTranslations("media.create.products");
	const pathname = usePathname();
	const selected = useRequestedImageModel();
	const [menu, setMenu] = useState<"tools" | "models" | null>(null);
	const catalog = useQuery(publicCatalogQueryOptions);
	const products = (catalog.data?.products ?? []).filter(
		(product) => isEditorProductKey(product.key) && product.skuMatrix?.cells.length,
	);
	const navigate = () => {
		setMenu(null);
		onNavigate?.();
	};
	const navigateToWorkspace = (
		event: MouseEvent<HTMLAnchorElement>,
		href: string,
		productKey: string,
	) => {
		if (
			pathname === href &&
			!event.defaultPrevented &&
			event.button === 0 &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.shiftKey &&
			!event.altKey
		) {
			event.preventDefault();
			window.history.replaceState(null, "", href);
			resetStudioWorkspace(productKey);
		}
		navigate();
	};
	const tools = (
		<>
			<Link
				href="/create"
				prefetch={false}
				onClick={(event) => navigateToWorkspace(event, "/create", DEFAULT_EDITOR_PRODUCT_KEY)}
				className={vertical ? "studio-nav-link" : "studio-menu-entry"}
				aria-current={pathname === "/create" && !selected ? "page" : undefined}
			>
				<ImagesIcon aria-hidden />
				<span>
					<strong>{t("imageToImage")}</strong>
					{!vertical && <small>{t("imageToImageDescription")}</small>}
				</span>
			</Link>
			<Link
				href="/examples"
				prefetch={false}
				onClick={navigate}
				className={vertical ? "studio-nav-link" : "studio-menu-entry"}
				aria-current={pathname === "/examples" ? "page" : undefined}
			>
				<LayoutGridIcon aria-hidden />
				<span>
					<strong>{t("examples")}</strong>
					{!vertical && <small>{t("examplesDescription")}</small>}
				</span>
			</Link>
			<Link
				href="/image-to-image"
				prefetch={false}
				onClick={navigate}
				className={vertical ? "studio-nav-link" : "studio-menu-entry"}
				aria-current={pathname === "/image-to-image" ? "page" : undefined}
			>
				<ImagesIcon aria-hidden />
				<span>
					<strong>{imageToImage("name")}</strong>
					{!vertical && <small>{imageToImage("navigationDescription")}</small>}
				</span>
			</Link>
		</>
	);
	const modelLinks = products.map((product) => {
		const href = imageModelHref(product.key);
		return (
			<Link
				key={product.key}
				href={href}
				prefetch={false}
				onClick={(event) => navigateToWorkspace(event, href, product.key)}
				className={
					vertical
						? `studio-nav-link${selected === product.key ? " is-active" : ""}`
						: "studio-menu-entry"
				}
				aria-current={selected === product.key ? "page" : undefined}
			>
				<span className={vertical ? "studio-nav-model-icon" : "studio-menu-model-icon"}>
					<ImageModelIcon productKey={product.key} size={vertical ? 18 : 24} />
				</span>
				<span>
					<strong>{models(`${product.key}.label`)}</strong>
					{!vertical && <small>{models(`${product.key}.description`)}</small>}
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
	if (drawer)
		return (
			<>
				<details className="studio-drawer-group">
					<summary>
						{t("imageTools")} <ChevronDownIcon aria-hidden />
					</summary>
					<div className="studio-drawer-links">{tools}</div>
				</details>
				<details className="studio-drawer-group">
					<summary>
						{t("models")} <ChevronDownIcon aria-hidden />
					</summary>
					<div className="studio-drawer-links">
						{modelContent}
						<Link href="/models" className="studio-nav-link" onClick={navigate} prefetch={false}>
							{t("models")} <span aria-hidden>→</span>
						</Link>
					</div>
				</details>
			</>
		);
	if (sidebar)
		return (
			<div className="studio-tool-sidebar">
				<p className="studio-nav-label">{t("imageTools")}</p>
				{tools}
				<Link href="/models" className="studio-nav-label" prefetch={false}>
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
							<Link
								href="/models"
								className="studio-menu-entry"
								onClick={navigate}
								prefetch={false}
							>
								{t("models")} <span aria-hidden>→</span>
							</Link>
						)}
					</PopoverContent>
				</Popover>
			))}
		</>
	);
}
