import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

export function GuestConversionActions({
	onBeginLink,
}: {
	onBeginLink: (destination: "login" | "signup") => void;
}) {
	const t = useTranslations("media.guest");
	return (
		<div className="border-violet-200 bg-violet-50/80 p-4 sm:p-5 rounded-2xl border">
			<div className="gap-3 sm:flex-row sm:items-center sm:justify-between flex flex-col">
				<p className="max-w-xl text-sm leading-6 text-slate-600">{t("accountDisclosure")}</p>
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
						className="min-h-11 bg-indigo-600 hover:bg-indigo-700"
						onClick={() => onBeginLink("signup")}
					>
						{t("createAccount")}
					</Button>
				</div>
			</div>
		</div>
	);
}
