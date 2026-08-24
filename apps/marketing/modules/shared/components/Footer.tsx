import { config } from "@config";
import { LocaleLink } from "@i18n/routing";
import { Logo } from "@repo/ui";
import { useTranslations } from "next-intl";

export function Footer() {
	const t = useTranslations();

	return (
		<footer className="py-8 text-sm border-t text-foreground/60">
			<div className="gap-6 lg:grid-cols-3 container grid grid-cols-1">
				<div>
					<Logo label={config.appName} className="opacity-70 grayscale" />
					<p className="mt-3 text-sm opacity-70">
						© {new Date().getFullYear()} {config.appName}.
					</p>
				</div>

				<div className="gap-2 flex flex-col">
					<LocaleLink href="/#examples" className="block">
						{t("common.menu.examples")}
					</LocaleLink>

					<LocaleLink href="/#how-it-works" className="block">
						{t("common.menu.howItWorks")}
					</LocaleLink>

					<LocaleLink href="/#pricing" className="block">
						{t("common.menu.pricing")}
					</LocaleLink>

					<LocaleLink href="/#faq" className="block">
						{t("common.menu.faq")}
					</LocaleLink>
				</div>

				<div className="gap-2 flex flex-col">
					<LocaleLink href="/legal/privacy-policy" className="block">
						{t("common.footer.privacyPolicy")}
					</LocaleLink>

					<LocaleLink href="/legal/terms" className="block">
						{t("common.footer.termsAndConditions")}
					</LocaleLink>

					{config.supportEmail && (
						<a href={`mailto:${config.supportEmail}`} className="block">
							{t("common.footer.support")}
						</a>
					)}
				</div>
			</div>
		</footer>
	);
}
