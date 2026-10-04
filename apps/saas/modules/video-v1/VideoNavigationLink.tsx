"use client";

import { FilmIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useVideoCatalog } from "./use-video";

export function VideoNavigationLink({
	className = "studio-nav-link",
	onNavigate,
}: {
	className?: string;
	onNavigate?: () => void;
}) {
	const t = useTranslations("app.menu");
	const pathname = usePathname();
	const catalog = useVideoCatalog();
	if (!catalog.data?.available) return null;
	return (
		<Link
			href="/video"
			className={className}
			prefetch={false}
			onClick={onNavigate}
			aria-current={pathname.startsWith("/video") ? "page" : undefined}
		>
			<FilmIcon aria-hidden className="size-5 shrink-0" />
			<span>{t("video")}</span>
		</Link>
	);
}
