import { Button } from "@repo/ui/components/button";
import { Clock3Icon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GuestTrialView } from "../../lib/guest-trial-state";

export function GuestStatusPanel({
	view,
	onViewStatus,
	onViewResult,
}: {
	view: GuestTrialView;
	onViewStatus: () => void;
	onViewResult: () => void;
}) {
	const t = useTranslations("media.guest");
	const busy = ["waiting", "delayed", "editing", "finishing", "moderatingOutput"].includes(
		view.state,
	);
	return (
		<section
			id="guest-status-region"
			tabIndex={-1}
			aria-busy={busy}
			aria-live="polite"
			className="border-violet-200 bg-white/85 p-4 shadow-sm focus-visible:ring-violet-600 sm:p-5 rounded-2xl border outline-none focus-visible:ring-2"
		>
			<div className="gap-3 flex items-start">
				<span className="size-10 bg-violet-100 text-violet-700 grid shrink-0 place-items-center rounded-xl">
					<SparklesIcon className="size-5" aria-hidden="true" />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="font-semibold text-slate-950">{t(`states.${view.state}`)}</h2>
					{(view.state === "waiting" || view.state === "delayed") && (
						<p className="mt-1 gap-2 text-sm text-slate-600 flex items-center">
							<Clock3Icon className="size-4 text-violet-600 shrink-0" aria-hidden="true" />
							{queueLabel(view, t)}
						</p>
					)}
					{view.jobId && view.state !== "ready" && (
						<Button type="button" variant="ghost" size="sm" className="mt-3" onClick={onViewStatus}>
							{t("viewStatus")}
						</Button>
					)}
					{view.state === "ready" && (
						<Button type="button" variant="ghost" size="sm" className="mt-3" onClick={onViewResult}>
							{t("viewResult")}
						</Button>
					)}
				</div>
			</div>
		</section>
	);
}

function queueLabel(view: GuestTrialView, t: ReturnType<typeof useTranslations>): string {
	if (view.state === "delayed" || !view.projectedDispatchAt) return t("startsWithCapacity");
	const start = new Date(view.projectedDispatchAt);
	if (Number.isNaN(start.getTime())) return t("startsWithCapacity");
	return t("estimatedStart", {
		start: start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
	});
}
