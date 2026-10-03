import "server-only";
import { config } from "@config";
import { PUBLIC_FOOTER_GROUPS } from "@shared/components/studio/public-navigation";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

import { getFeaturedPhotoIdeas } from "../lib/content";

import "./public-footer.css";

const legalLinks = [
	{ href: "/pricing", labelKey: "common.menu.pricing" },
	{ href: "/privacy", labelKey: "common.footer.privacyPolicy" },
	{ href: "/terms", labelKey: "common.footer.termsAndConditions" },
	{ href: "/contact#report-content", labelKey: "publicContent.contact.reporting.footerLabel" },
] as const;

export function PublicFooterLinks({ className }: { className?: string }) {
	const t = useTranslations();
	const featuredPhotoIdeas = getFeaturedPhotoIdeas(useLocale(), 2);

	return (
		<div className={`public-footer-navigation ${className ?? ""}`} data-footer-navigation>
			<div className="public-footer-groups">
				{PUBLIC_FOOTER_GROUPS.map((group) => (
					<nav key={group.id} aria-label={t(group.labelKey)} data-footer-group={group.id}>
						<h2>{t(group.labelKey)}</h2>
						<ul>
							{group.links.map(({ href, labelKey }) => (
								<li key={href}>
									<Link href={href} prefetch={false}>
										{t(labelKey)}
									</Link>
								</li>
							))}
							{group.id === "resources" &&
								featuredPhotoIdeas.map((post) => (
									<li key={post.slug}>
										<Link href={`/blog/${post.slug}`} prefetch={false}>
											{post.title}
										</Link>
									</li>
								))}
						</ul>
					</nav>
				))}
			</div>
			<div className="public-footer-bottom">
				<div className="public-footer-legal">
					{legalLinks.map(({ href, labelKey }) => (
						<Link key={href} href={href} prefetch={false}>
							{t(labelKey)}
						</Link>
					))}
				</div>
				{config.supportEmail && (
					<a href={`mailto:${config.supportEmail}`} className="public-footer-support">
						{t("common.footer.support")}: {config.supportEmail}
					</a>
				)}
			</div>
		</div>
	);
}
