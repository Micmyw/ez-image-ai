"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import { type FeedbackKind, scheduleFeedbackReveal } from "../lib/feedback";

import "./feedback.css";

const FeedbackDialog = dynamic(
	() => import("./FeedbackDialog").then((module) => module.FeedbackDialog),
	{
		ssr: false,
	},
);

function GiftIcon() {
	return (
		<svg
			className="feedback-gift"
			viewBox="0 0 32 32"
			width="24"
			height="24"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M5 14h22v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" fill="#ab83f5" />
			<path d="M17 14h10v14a2 2 0 0 1-2 2h-8Z" fill="#8460d4" />
			<rect x="3" y="10" width="26" height="7" rx="2" fill="#ff9aa7" />
			<path d="M14 10h4v20h-4Z" fill="#ffe18c" />
			<path
				d="M16 10C4 11 6 1 11 3c3 1 5 7 5 7Zm0 0c12 1 10-9 5-7-3 1-5 7-5 7Z"
				fill="none"
				stroke="#ffe18c"
				strokeWidth="3"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function FeedbackButton({
	supportEmail,
	variant = "inline",
	kind = "idea",
}: {
	supportEmail?: string;
	variant?: "inline" | "footer" | "report";
	kind?: FeedbackKind;
}) {
	const t = useTranslations("feedback");
	const [open, setOpen] = useState(false);
	const [requested, setRequested] = useState(false);
	const [burst, setBurst] = useState(false);
	const cancelReveal = useRef<(() => void) | null>(null);
	useEffect(() => () => cancelReveal.current?.(), []);
	if (!supportEmail) return null;
	const finishReveal = () => {
		cancelReveal.current?.();
		cancelReveal.current = null;
		setBurst(false);
		setOpen(true);
	};
	return (
		<>
			<button
				type="button"
				className={`feedback-trigger feedback-trigger-${variant}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => {
					if (burst) return;
					setRequested(true);
					const reducedMotion =
						variant === "report" ||
						(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
					setBurst(!reducedMotion);
					cancelReveal.current = scheduleFeedbackReveal(finishReveal, reducedMotion);
				}}
			>
				<span className="feedback-gift-wrap" aria-hidden="true">
					<GiftIcon />
					{burst && (
						<span
							className="feedback-burst"
							onAnimationEnd={(event) => {
								if (event.target === event.currentTarget) finishReveal();
							}}
						>
							<i>✦</i>
							<i>✧</i>
							<i>✦</i>
							<i>✧</i>
							<i>✦</i>
							<i>✧</i>
						</span>
					)}
				</span>
				<span>
					{t(variant === "report" ? "report" : variant === "footer" ? "footer" : "entry")}
				</span>
			</button>
			{requested && (
				<FeedbackDialog
					open={open}
					onOpenChange={setOpen}
					supportEmail={supportEmail}
					initialKind={kind}
				/>
			)}
		</>
	);
}
