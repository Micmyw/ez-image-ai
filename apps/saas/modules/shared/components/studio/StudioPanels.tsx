"use client";

import { useSession } from "@auth/hooks/use-session";
import type { ComponentType } from "react";

import type { StudioPanel } from "./studio-context";

export interface StudioPanelProps {
	panel: StudioPanel;
	onChange: (panel: StudioPanel) => void;
	onClose: () => void;
}

/** Only the selected, already loaded view is mounted, so preloading code never queries an account. */
export function StudioPanels({
	component: Panel,
	...props
}: StudioPanelProps & { component: ComponentType<StudioPanelProps> }) {
	const { user } = useSession();
	if (!user) return null;
	return (
		<div data-clarity-mask="true">
			<Panel {...props} />
		</div>
	);
}
