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
					<a
						href={`mailto:${config.supportEmail}`}
						className="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
					>
						{t("support")}: {config.supportEmail}
					</a>
				</>
			)}
		</footer>
	);
}
