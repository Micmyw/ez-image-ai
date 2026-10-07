"use client";

import { FilmIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { RUMPELSTILTSKIN_PATH } from "../lib/paths";

/** Loaded by the shared Studio shell only for registered accounts. */
export function RumpelstiltskinNavigationLink({ onNavigate }: { onNavigate?: () => void }) {
	const t = useTranslations("app.menu");
	const active = usePathname() === RUMPELSTILTSKIN_PATH;
	return (
		<Link
			data-test="rumpelstiltskin-navigation"
			className={active ? "studio-nav-link is-active" : "studio-nav-link"}
			href={RUMPELSTILTSKIN_PATH}
			prefetch={false}
			onClick={onNavigate}
			aria-current={active ? "page" : undefined}
		>
			<FilmIcon aria-hidden />
			{t("rumpelstiltskin")}
		</Link>
	);
}
