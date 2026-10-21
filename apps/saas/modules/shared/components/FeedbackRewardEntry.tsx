"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { FeedbackButton } from "./FeedbackButton";

const dismissalKey = "ezpic:feedback-reward-entry:dismissed:v1";
// Only a browser click adds its window; server rendering never records a dismissal.
const dismissedVisits = new WeakSet<Window>();

export function FeedbackRewardEntry({ supportEmail }: { supportEmail?: string }) {
	const t = useTranslations("feedback");
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (!supportEmail) return;
		let dismissed = dismissedVisits.has(window);
		try {
			dismissed ||= window.sessionStorage.getItem(dismissalKey) === "1";
		} catch {
			// The in-memory choice survives client navigation when storage is blocked.
		}
		setVisible(!dismissed);
	}, [supportEmail]);
	if (!supportEmail || !visible) return null;

	function dismiss() {
		setVisible(false);
		dismissedVisits.add(window);
		try {
			window.sessionStorage.setItem(dismissalKey, "1");
		} catch {
			// Keep the in-memory dismissal for the rest of this browser visit.
		}
	}

	return (
		<aside
			className="feedback-reward-entry"
			data-test="feedback-reward-entry"
			aria-label={t("rewardTitle")}
		>
			<FeedbackButton supportEmail={supportEmail} variant="reward" />
			<button
				type="button"
				className="feedback-reward-dismiss"
				aria-label={t("dismissReward")}
				onClick={dismiss}
			>
				<span aria-hidden="true">×</span>
			</button>
		</aside>
	);
}
