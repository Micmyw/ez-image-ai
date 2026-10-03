"use client";

import { ImagePrintButton } from "@media/components/ImagePrintButton";
import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { LandingGenerator } from "../../landing/components/LandingGenerator";
import { readColoringSourceImage } from "../lib/source-image";

export function GuestColoringSource({
	assetId,
	jobId,
	registered,
}: {
	assetId: string;
	jobId: string;
	registered: boolean;
}) {
	const t = useTranslations("coloring.handoff");
	const [source, setSource] = useState<{ file: File; url: string } | null>(null);
	const [failed, setFailed] = useState(false);
	const [retry, setRetry] = useState(0);
	const [uploadOwn, setUploadOwn] = useState(false);
	useEffect(() => {
		if (uploadOwn) return;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		let active = true;
		let preview: string | undefined;
		setSource(null);
		setFailed(false);
		async function load() {
			if (!assetId || !jobId || assetId.length > 256 || jobId.length > 256)
				throw new Error("COLORING_SOURCE_UNAVAILABLE");
			const access = registered
				? await orpcClient.media.getAssetAccessUrl(
						{ assetId, disposition: "inline" },
						{ signal: controller.signal },
					)
				: await orpcClient.media.getGuestAssetAccessUrl(
						{ assetId, jobId, disposition: "inline" },
						{ signal: controller.signal },
					);
			controller.signal.throwIfAborted();
			const file = await readColoringSourceImage(access.url, { signal: controller.signal });
			if (!active) return;
			preview = URL.createObjectURL(file);
			setSource({ file, url: preview });
		}
		void load()
			.catch(() => {
				if (active) setFailed(true);
			})
			.finally(() => clearTimeout(timer));
		return () => {
			active = false;
			clearTimeout(timer);
			controller.abort();
			if (preview) URL.revokeObjectURL(preview);
		};
	}, [assetId, jobId, registered, retry, uploadOwn]);

	if (uploadOwn) return <LandingGenerator requireReference />;
	if (failed)
		return (
			<div className="space-y-3">
				<p role="alert">{t("unavailable")}</p>
				<div className="gap-2 flex flex-wrap">
					<Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>
						{t("retry")}
					</Button>
					<Button variant="ghost" onClick={() => setUploadOwn(true)}>
						{t("uploadOwn")}
					</Button>
				</div>
			</div>
		);
	if (!source)
		return (
			<output className="block" aria-busy="true">
				{t("loading")}
			</output>
		);
	return (
		<>
			<output className="mb-3 text-sm block">{t("ready")}</output>
			<LandingGenerator requireReference initialFile={source.file} />
			<div className="mt-4 space-y-2" data-test="coloring-source-print">
				<p className="text-sm">{t("printSelected")}</p>
				<ImagePrintButton imageUrl={source.url} />
			</div>
		</>
	);
}
