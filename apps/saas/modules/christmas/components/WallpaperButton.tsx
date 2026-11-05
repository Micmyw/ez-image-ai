"use client";

import { Button } from "@repo/ui/components/button";
import { SmartphoneIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";

import type { WallpaperCropSettings } from "../lib/wallpaper";

const WallpaperCropDialog = dynamic(() =>
	import("./WallpaperCropDialog").then((module) => module.WallpaperCropDialog),
);

export function WallpaperButton({
	imageUrl,
	getImageUrl,
	label,
	initialCrop,
	onApply,
}: {
	imageUrl?: string;
	getImageUrl?: () => Promise<string>;
	label?: string;
	initialCrop?: WallpaperCropSettings;
	onApply?: (settings: WallpaperCropSettings) => void;
}) {
	const t = useTranslations("christmas");
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" variant="secondary" onClick={() => setOpen(true)}>
				<SmartphoneIcon className="size-4" aria-hidden="true" />
				{label ?? t("crop.action")}
			</Button>
			{open && (
				<WallpaperCropDialog
					open={open}
					onOpenChange={setOpen}
					imageUrl={imageUrl}
					getImageUrl={getImageUrl}
					initialCrop={initialCrop}
					onApply={onApply}
				/>
			)}
		</>
	);
}
