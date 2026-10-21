"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { type FeedbackKind, scheduleFeedbackReveal } from "../lib/feedback";

import "./feedback-trigger.css";

type FeedbackDialogComponent = typeof import("./FeedbackDialog").FeedbackDialog;

/** Static code only: preloading must not mount the form or load any account data. */
export function createFeedbackDialogResource(load: () => Promise<FeedbackDialogComponent>) {
	let pending: Promise<FeedbackDialogComponent> | null = null;
	let component: FeedbackDialogComponent | null = null;
	return {
		read: () => component,
		load(this: void) {
			if (pending) return pending;
			pending = load()
				.then((loaded) => {
					component = loaded;
					return loaded;
				})
				.catch((error: unknown) => {
					pending = null;
					throw error;
				});
			return pending;
		},
	};
}

export const feedbackDialogResource = createFeedbackDialogResource(() =>
	import("./FeedbackDialog").then((module) => module.FeedbackDialog),
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
	variant?: "inline" | "footer" | "report" | "reward";
	kind?: FeedbackKind;
}) {
	const t = useTranslations("feedback");
	const studio = useTranslations("studio");
	const statusId = useId();
	const [open, setOpen] = useState(false);
	const [requested, setRequested] = useState(false);
	const [burst, setBurst] = useState(false);
	const [Dialog, setDialog] = useState<FeedbackDialogComponent | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const cancelReveal = useRef<(() => void) | null>(null);
	const requestVersion = useRef(0);
	const pending = !Dialog && (open || burst);
	const cancelOpening = useCallback(() => {
		requestVersion.current += 1;
		cancelReveal.current?.();
		cancelReveal.current = null;
		setBurst(false);
		setOpen(false);
		trigger.current?.focus({ preventScroll: true });
	}, []);
	useEffect(
		() => () => {
			requestVersion.current += 1;
			cancelReveal.current?.();
		},
		[],
	);
	useEffect(() => {
		if (!pending) return;
		function escape(event: KeyboardEvent) {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			cancelOpening();
		}
		document.addEventListener("keydown", escape);
		return () => document.removeEventListener("keydown", escape);
	}, [pending, cancelOpening]);
	if (!supportEmail) return null;
	const preload = () => {
		// After an explicit open, failures retry only from the user's open/retry action.
		if (!requested) void feedbackDialogResource.load().catch(() => {});
	};
	const loadDialog = () => {
		const version = ++requestVersion.current;
		setLoadFailed(false);
		const cached = feedbackDialogResource.read();
		if (cached) {
			setDialog(() => cached);
			return;
		}
		void feedbackDialogResource.load().then(
			(component) => {
				if (requestVersion.current === version) setDialog(() => component);
			},
			() => {
				if (requestVersion.current === version) setLoadFailed(true);
			},
		);
	};
	const finishReveal = () => {
		cancelReveal.current?.();
		cancelReveal.current = null;
		setBurst(false);
		setOpen(true);
	};
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className={`feedback-trigger feedback-trigger-${variant}`}
				aria-haspopup="dialog"
				aria-expanded={open || burst}
				aria-busy={pending && !loadFailed ? true : undefined}
				aria-describedby={pending ? statusId : undefined}
				onPointerEnter={preload}
				onFocus={preload}
				onClick={() => {
					if (burst) return;
					setRequested(true);
					if (!Dialog) loadDialog();
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
				{variant === "reward" ? (
					<span className="feedback-reward-copy">
						<strong>{t("rewardTitle")}</strong>
						<span>{t("rewardDescription")}</span>
					</span>
				) : (
					<span>
						{t(variant === "report" ? "report" : variant === "footer" ? "footer" : "entry")}
					</span>
				)}
			</button>
			{pending && (
				<span
					id={statusId}
					className="ml-2 gap-2 text-xs inline-flex flex-wrap items-center"
					role={loadFailed ? "alert" : "status"}
				>
					<span>{studio(loadFailed ? "error" : "loading")}</span>
					{loadFailed && (
						<button
							type="button"
							className="min-h-11 px-2 underline focus-visible:outline-2"
							onClick={() => {
								finishReveal();
								loadDialog();
							}}
						>
							{studio("retry")}
						</button>
					)}
					<button
						type="button"
						className="min-h-11 px-2 underline focus-visible:outline-2"
						onClick={cancelOpening}
					>
						{studio("closePanel")}
					</button>
				</span>
			)}
			{requested && Dialog && (
				<Dialog open={open} onOpenChange={setOpen} supportEmail={supportEmail} initialKind={kind} />
			)}
		</>
	);
}
