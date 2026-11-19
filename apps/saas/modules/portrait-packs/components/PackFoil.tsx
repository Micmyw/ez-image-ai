import { MoveRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import styles from "./portrait-pack.module.css";

export function PackFoil({ tearing = false }: { tearing?: boolean }) {
	const t = useTranslations("portraitPacks");
	return (
		<span aria-hidden="true" className={styles.foil} data-tearing={tearing || undefined}>
			<span className={styles.seal} />
			<span className={styles.tearLine}>
				{t("tearHere")} <MoveRightIcon size={16} />
			</span>
			<span className={styles.foilBrand}>
				EzImageAI
				<span className={styles.foilTitle}>{t("collection")}</span>
			</span>
			<span className={styles.emblem}>
				<i />
				<i />
				<i />
			</span>
			<span className={styles.foilCount}>{t("fiveCards")}</span>
		</span>
	);
}
