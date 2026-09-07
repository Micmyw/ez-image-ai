import { useTranslations } from "next-intl";
import Link from "next/link";

const publicLinks = [
	{ href: "/privacy", labelKey: "common.footer.privacyPolicy" },
	{ href: "/terms", labelKey: "common.footer.termsAndConditions" },
	{ href: "/blog", labelKey: "common.footer.blog" },
	{ href: "/changelog", labelKey: "common.menu.changelog" },
	{ href: "/contact", labelKey: "common.menu.contact" },
	{ href: "/docs", labelKey: "common.menu.docs" },
] as const;

export function PublicFooterLinks({ className }: { className?: string }) {
	const t = useTranslations();

	return (
		<div className={className ?? "gap-x-4 gap-y-2 flex flex-wrap items-center justify-center"}>
			{publicLinks.map(({ href, labelKey }) => (
				<Link
					key={href}
					href={href}
					className="rounded hover:text-white focus-visible:outline-violet-300 transition focus-visible:outline-2 focus-visible:outline-offset-4"
				>
					{t(labelKey)}
				</Link>
			))}
		</div>
	);
}
