"use client";

import { ImageModelIcon } from "@media/components/ImageModelIcon";
import { imageModelHref, useRequestedImageModel } from "@media/hooks/use-model-navigation";
import { DEFAULT_EDITOR_PRODUCT_KEY, isEditorProductKey } from "@media/lib/editor-recovery";
import { publicCatalogQueryOptions } from "@media/lib/public-catalog-query";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { useQuery } from "@tanstack/react-query";
import {
	BookOpenIcon,
	ChevronDownIcon,
	ImagesIcon,
	FilmIcon,
	LayoutGridIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type MouseEvent, useState } from "react";

import {
	PUBLIC_NAVIGATION_GROUPS,
	type PublicNavigationGroup,
	type PublicNavigationLink,
} from "./public-navigation";
import { resetStudioWorkspace } from "./studio-context";

const navigationIcons = {
	image: ImagesIcon,
	video: FilmIcon,
	examples: LayoutGridIcon,
	book: BookOpenIcon,
	models: SparklesIcon,
};

export function StudioToolNavigation({
	sidebar = false,
	drawer = false,
	onNavigate,
}: {
	sidebar?: boolean;
	drawer?: boolean;
	onNavigate?: () => void;
}) {
	const t = useTranslations();
	const vertical = sidebar || drawer;
	const pathname = usePathname();
	const videoMode = useSearchParams().get("mode") === "video";
	const selected = useRequestedImageModel();
	const [menu, setMenu] = useState<PublicNavigationGroup["id"] | null>(null);
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
	const navigationLink = (link: PublicNavigationLink) => {
		const Icon = navigationIcons[link.icon];
		const active =
			link.href === "/create?mode=video"
				? pathname === "/create" && videoMode
				: link.href === "/create"
					? pathname === link.href && !selected && !videoMode
					: pathname === link.href || pathname.startsWith(`${link.href}/`);
		return (
			<Link
				key={link.href}
				href={link.href}
				prefetch={false}
				onClick={(event) =>
					link.href === "/create"
						? navigateToWorkspace(event, link.href, DEFAULT_EDITOR_PRODUCT_KEY)
						: navigate()
				}
				className={vertical ? "studio-nav-link" : "studio-menu-entry"}
				aria-current={active ? "page" : undefined}
			>
				<Icon aria-hidden />
				<span>
					<strong>{t(link.labelKey)}</strong>
					{!vertical && "descriptionKey" in link && <small>{t(link.descriptionKey)}</small>}
				</span>
			</Link>
		);
	};
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
					<strong>{t(`media.create.products.${product.key}.label`)}</strong>
					{!vertical && <small>{t(`media.create.products.${product.key}.description`)}</small>}
				</span>
			</Link>
		);
	});
	const modelContent = modelLinks.length ? (
		modelLinks
	) : (
		<output className="studio-menu-status">
			{t(catalog.isPending ? "studio.tools.loading" : "studio.tools.unavailable")}
		</output>
	);
	const groupContent = (group: PublicNavigationGroup) => (
		<>
			{group.id === "models" && (
				<div className={vertical ? undefined : "studio-model-grid"}>{modelContent}</div>
			)}
			{group.links.map(navigationLink)}
		</>
	);
	if (drawer)
		return PUBLIC_NAVIGATION_GROUPS.map((group) => (
			<details className="studio-drawer-group" key={group.id} data-navigation-group={group.id}>
				<summary>
					{t(group.labelKey)} <ChevronDownIcon aria-hidden />
				</summary>
				<div className="studio-drawer-links">{groupContent(group)}</div>
			</details>
		));
	if (sidebar)
		return (
			<div className="studio-tool-sidebar">
				{PUBLIC_NAVIGATION_GROUPS.map((group) => (
					<section key={group.id} data-navigation-group={group.id}>
						<p className="studio-nav-label">{t(group.labelKey)}</p>
						{groupContent(group)}
					</section>
				))}
			</div>
		);
	return PUBLIC_NAVIGATION_GROUPS.map((group) => (
		<Popover
			key={group.id}
			open={menu === group.id}
			onOpenChange={(open) => setMenu(open ? group.id : null)}
		>
			<PopoverTrigger
				render={
					<button
						type="button"
						className="studio-menu-trigger"
						data-test={`studio-${group.id}-menu`}
					>
						{t(group.labelKey)}
						<ChevronDownIcon aria-hidden />
					</button>
				}
			/>
			<PopoverContent
				align="start"
				sideOffset={12}
				positionerClassName="z-[70]"
				className={`studio-theme studio-navigation-popover ${group.id === "models" ? "studio-model-popover" : ""}`}
				aria-label={t(group.labelKey)}
			>
				{groupContent(group)}
			</PopoverContent>
		</Popover>
	));
}
