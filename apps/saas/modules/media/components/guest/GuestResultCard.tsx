import { Button } from "@repo/ui/components/button";
import { trackJourneyResultVisible } from "@shared/lib/generation-journey";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { DownloadIcon, ImageIcon } from "lucide-react";
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
			className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{view.state === "ready" && resultUrl && view.resultAssetId && (
				<WallpaperResultPublisher
					assetId={view.resultAssetId}
					imageUrl={resultUrl}
					expiresAt={view.resultExpiresAt ?? undefined}
				/>
			)}
			<div className="min-h-48 relative aspect-[4/3] max-h-[65vh] overflow-hidden bg-background">
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
					<div className="gap-3 p-6 flex size-full flex-col items-center justify-center text-center text-muted-foreground">
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
			{view.state === "ready" && resultUrl && (
				<div className="p-4 sm:px-5 border-t border-border">
					<div className="gap-3 flex flex-wrap items-start justify-between">
						<Button type="button" variant="primary" className="min-h-11" onClick={onDownload}>
							<DownloadIcon className="size-4" aria-hidden="true" />
							{t("download")}
						</Button>
						<details className="text-sm max-w-full text-muted-foreground">
							<summary className="min-h-11 px-2 content-center rounded-lg">
								{t("moreActions")}
							</summary>
							<div className="gap-2 pt-2 flex flex-wrap">
								{view.resultAssetId && view.jobId && (
									<ColoringPageLink assetId={view.resultAssetId} guestJobId={view.jobId} />
								)}
								{resultUrl && <WallpaperButton key={view.resultAssetId} imageUrl={resultUrl} />}
							</div>
						</details>
					</div>
					{view.resultExpiresAt && (
						<p className="mt-3 text-xs text-muted-foreground">
							{t("resultExpires", { date: new Date(view.resultExpiresAt).toLocaleString() })}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
