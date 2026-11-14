import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

export function GuestConversionActions({
	onBeginLink,
}: {
	onBeginLink: (destination: "login" | "signup") => void;
}) {
	const t = useTranslations("media.guest");
	return (
		<div className="p-4 sm:p-5 rounded-2xl border border-border bg-card">
			<div className="gap-3 sm:flex-row sm:items-center sm:justify-between flex flex-col">
				<div className="min-w-0 space-y-1">
					<h2 className="font-semibold">{t("continueTitle")}</h2>
					<p className="text-sm text-muted-foreground">{t("continueDescription")}</p>
				</div>
				<div className="gap-2 flex flex-wrap">
					<Button
						type="button"
						variant="secondary"
						className="min-h-11"
						onClick={() => onBeginLink("login")}
					>
						{t("signIn")}
					</Button>
					<Button
						type="button"
						variant="primary"
						className="min-h-11"
						onClick={() => onBeginLink("signup")}
					>
						{t("createAccount")}
					</Button>
				</div>
			</div>
			<details className="mt-3 text-xs text-muted-foreground">
				<summary className="py-2 w-fit">{t("trialDetails")}</summary>
				<div className="max-w-3xl space-y-2 pb-1 pt-2 leading-6">
					<p>{t("loginBonus")}</p>
					<p>{t("accountDisclosure")}</p>
				</div>
			</details>
		</div>
	);
}
