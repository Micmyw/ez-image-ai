"use client";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@repo/ui/components/dialog";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { PackFoil } from "./PackFoil";

import styles from "./portrait-pack.module.css";

const PortraitPackExperience = dynamic(() =>
	import("./PortraitPackExperience").then((module) => module.PortraitPackExperience),
);

// One invitation at a time even when the same rejection surfaces in two editor panels.
let openInvitation: symbol | null = null;

export function PortraitPackInvitation() {
	const t = useTranslations("portraitPacks");
	const [instance] = useState(() => Symbol());
	const [open, setOpen] = useState(false);
	const [accepted, setAccepted] = useState(false);
	useEffect(() => {
		if (!openInvitation) {
			openInvitation = instance;
			setOpen(true);
		}
		return () => {
			if (openInvitation === instance) openInvitation = null;
		};
	}, [instance]);

	function changeOpen(value: boolean) {
		if (value && openInvitation && openInvitation !== instance) return;
		if (value) openInvitation = instance;
		else if (openInvitation === instance) openInvitation = null;
		setOpen(value);
	}

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<button className={styles.inviteLink} type="button" onClick={() => changeOpen(true)}>
				{t("name")} <ChevronRightIcon size={16} />
			</button>
			<DialogContent
				data-test="portrait-pack-invitation"
				closeLabel={t("close")}
				className={`${styles.dialog} ${accepted ? styles.playDialog : ""}`}
			>
				{accepted ? (
					<>
						<DialogTitle className={styles.playTitle}>{t("name")}</DialogTitle>
						<DialogDescription className="sr-only">{t("pageDescription")}</DialogDescription>
						<PortraitPackExperience compact />
					</>
				) : (
					<div className={styles.invitation}>
						<div className={styles.invitePack}>
							<PackFoil />
						</div>
						<div>
							<DialogTitle className={styles.inviteTitle}>{t("invitationTitle")}</DialogTitle>
							<DialogDescription className={styles.inviteDescription}>
								{t("invitationDescription")}
							</DialogDescription>
							<div className={styles.inviteActions}>
								<button
									type="button"
									className={styles.primary}
									onClick={() => setAccepted(true)}
								>
									{t("tryPack")}
								</button>
								<button
									type="button"
									className={styles.secondary}
									onClick={() => changeOpen(false)}
								>
									{t("later")}
								</button>
							</div>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
