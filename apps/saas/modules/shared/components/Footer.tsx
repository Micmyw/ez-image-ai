import { config } from "@config";
import { cn } from "@repo/ui";
import { useTranslations } from "next-intl";

export function Footer() {
	const t = useTranslations("common.footer");

	return (
		<footer className={cn("max-w-6xl py-6 text-xs container text-center text-foreground/60")}>
			<span>
				© {new Date().getFullYear()} {config.appName}.
			</span>
			{config.supportEmail && (
				<>
					{" · "}
					<a href={`mailto:${config.supportEmail}`}>{t("support")}</a>
				</>
			)}
		</footer>
	);
}
