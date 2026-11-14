"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

const Providers = dynamic(() =>
	import("./RegisteredWorkspaceProviders").then((module) => module.RegisteredWorkspaceProviders),
);

// The homepage imports the server account boundary in both session states.
// Download its account-only providers only when that boundary actually renders.
export function DeferredRegisteredWorkspaceProviders(props: ComponentProps<typeof Providers>) {
	return <Providers {...props} />;
}
