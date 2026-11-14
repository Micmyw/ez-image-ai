import { Button } from "@repo/ui/components/button";
import { Clock3Icon, LoaderCircleIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GuestTrialView } from "../../lib/guest-trial-state";

export function GuestStatusPanel({
	view,
	onViewStatus,
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
			className={
				view.state === "ready"
					? "sr-only"
					: "p-4 rounded-2xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
			}
		>
			<div className="gap-3 flex items-start">
				<span className="size-8 grid shrink-0 place-items-center text-ring">
					<LoaderCircleIcon
						className={busy ? "size-5 motion-safe:animate-spin" : "size-5"}
						aria-hidden="true"
					/>
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="font-medium">{t(`states.${view.state}`)}</h2>
					{(view.state === "waiting" || view.state === "delayed") && (
						<p className="mt-1 gap-2 text-sm flex items-center text-muted-foreground">
							<Clock3Icon className="size-4 shrink-0" aria-hidden="true" />
							{queueLabel(view, t)}
						</p>
					)}
					{view.jobId && view.state !== "ready" && (
						<Button type="button" variant="ghost" size="sm" className="mt-3" onClick={onViewStatus}>
							{t("viewStatus")}
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
