import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

export function CreditBalanceSummary({
	requiredCredits,
	availableCredits,
	onUpgrade,
}: {
	requiredCredits: number;
	availableCredits: string;
	onUpgrade: () => void;
}) {
	const t = useTranslations("media.create");

	return (
		<div className="mt-3 gap-3 flex flex-wrap items-center justify-between">
			<div className="text-sm">
				<p>{t("requiredCredits", { credits: requiredCredits })}</p>
				<p>{t("availableCredits", { credits: availableCredits })}</p>
			</div>
			<Button type="button" size="sm" variant="secondary" onClick={onUpgrade}>
				{t("upgrade")}
			</Button>
		</div>
	);
}
