import { Button } from "@repo/ui/components/button";
import { trackJourneyResultVisible } from "@shared/lib/generation-journey";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { ImageIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { WallpaperButton } from "../../../christmas/components/WallpaperButton";
import { WallpaperResultPublisher } from "../../../christmas/lib/wallpaper-result-context";
import { ColoringPageLink } from "../../../coloring/components/ColoringPageLink";
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
	const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
	useEffect(() => {
		if (
			!loadedImage ||
			!view.jobId ||
			!view.resultAssetId ||
			typeof IntersectionObserver === "undefined"
		)
			return;
		let visible = false;
		let recorded = false;
		const record = () => {
			if (
				recorded ||
				!visible ||
				document.visibilityState !== "visible" ||
				!loadedImage.isConnected ||
				!loadedImage.naturalWidth ||
				typeof loadedImage.checkVisibility !== "function" ||
				!loadedImage.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
			)
				return;
			recorded = true;
			void trackJourneyResultVisible(view.jobId!);
			void saasGrowthFunnel.guestResultViewed(view.resultAssetId!);
		};
		const observer = new IntersectionObserver(([entry]) => {
			visible = Boolean(entry?.isIntersecting);
			record();
		});
		observer.observe(loadedImage);
		document.addEventListener("visibilitychange", record);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", record);
		};
	}, [loadedImage, view.jobId, view.resultAssetId]);
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
			{view.state === "ready" && resultUrl && view.resultAssetId && (
				<WallpaperResultPublisher
					assetId={view.resultAssetId}
					imageUrl={resultUrl}
					expiresAt={view.resultExpiresAt ?? undefined}
				/>
			)}
			<div className="mb-3 gap-2 font-semibold text-slate-300 sm:text-xs flex items-center justify-between text-[0.6875rem] tracking-[0.1em] uppercase">
				<span className="shrink-0">{t("oneOutput")}</span>
				<span className="min-w-0 gap-1.5 bg-white/10 px-2 py-1 tracking-normal flex items-center rounded-full whitespace-nowrap normal-case">
					<LockKeyholeIcon className="size-3" aria-hidden="true" />
					{t("temporaryCompact")}
				</span>
			</div>
			<div className="border-white/10 bg-slate-900 relative aspect-[4/3] overflow-hidden rounded-xl border">
				{view.state === "ready" && resultUrl ? (
					<img
						key={resultUrl}
						src={resultUrl}
						alt={t("resultAlt")}
						className="size-full object-contain"
						onLoad={(event) => {
							const element = event.currentTarget;
							void element
								.decode()
								.then(() => {
									if (element.isConnected) setLoadedImage(element);
								})
								.catch(() => undefined);
						}}
					/>
				) : (
					<div className="gap-3 p-6 text-slate-400 flex size-full flex-col items-center justify-center text-center">
						<ImageIcon className="size-8" aria-hidden="true" />
						<p className="text-sm">{t("resultPlaceholder")}</p>
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
					{view.resultAssetId && view.jobId && (
						<ColoringPageLink assetId={view.resultAssetId} guestJobId={view.jobId} />
					)}
					{resultUrl && <WallpaperButton key={view.resultAssetId} imageUrl={resultUrl} />}
				</div>
			)}
		</section>
	);
}
