import { Button } from "@repo/ui/components/button";
import { ImageIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GuestTrialView } from "../../lib/guest-trial-state";

export function GuestResultCard({
	view,
	resultUrl,
	onDownload,
}: {
	view: GuestTrialView;
	resultUrl: string | null;
	onDownload: () => void;
}) {
	const t = useTranslations("media.guest");
	const busy = Boolean(
		view.jobId && !["ready", "rejected", "failed", "expired"].includes(view.state),
	);
	return (
		<section
			id="guest-result-region"
			tabIndex={-1}
			aria-busy={busy}
			className="border-slate-800 bg-slate-950 p-4 text-white focus-visible:ring-violet-400 sm:p-5 rounded-2xl border shadow-[0_24px_70px_-32px_rgba(30,27,75,0.9)] outline-none focus-visible:ring-2"
		>
			<div className="mb-3 gap-3 text-xs font-semibold text-slate-300 flex items-center justify-between tracking-[0.1em] uppercase">
				<span>{t("oneOutput")}</span>
				<span className="gap-1.5 bg-white/10 px-2.5 py-1 tracking-normal flex items-center rounded-full normal-case">
					<LockKeyholeIcon className="size-3" aria-hidden="true" />
					{t("temporary")}
				</span>
			</div>
			<div className="border-white/10 bg-slate-900 relative aspect-[4/3] overflow-hidden rounded-xl border">
				{view.state === "ready" && resultUrl ? (
					<img src={resultUrl} alt={t("resultAlt")} className="size-full object-contain" />
				) : (
					<div className="gap-3 p-6 text-slate-400 flex size-full flex-col items-center justify-center text-center">
						<ImageIcon className="size-8" aria-hidden="true" />
						<p className="text-sm">{t(`states.${view.state}`)}</p>
					</div>
				)}
				{busy && (
					<div
						className="inset-x-0 via-violet-300/80 motion-safe:animate-pulse pointer-events-none absolute top-1/3 h-px bg-gradient-to-r from-transparent to-transparent motion-reduce:animate-none"
						aria-hidden="true"
					/>
				)}
			</div>
			{view.state === "ready" && view.resultExpiresAt && (
				<div className="mt-4 gap-3 flex flex-wrap items-center justify-between">
					<p className="text-sm text-slate-300">
						{t("resultExpires", { date: new Date(view.resultExpiresAt).toLocaleString() })}
					</p>
					<Button type="button" variant="primary" className="min-h-11" onClick={onDownload}>
						{t("download")}
					</Button>
				</div>
			)}
		</section>
	);
}
