"use client";

import { AssetLibrary } from "@media/components/AssetLibrary";

import { STUDIO_ASSET_SELECTED_EVENT } from "../studio-context";
import type { StudioPanelProps } from "../StudioPanels";

export function AssetsPanel({ onClose }: StudioPanelProps) {
	return (
		<AssetLibrary
			embedded
			onSelect={(assetId) => {
				window.dispatchEvent(new CustomEvent(STUDIO_ASSET_SELECTED_EVENT, { detail: { assetId } }));
				onClose();
			}}
		/>
	);
}
