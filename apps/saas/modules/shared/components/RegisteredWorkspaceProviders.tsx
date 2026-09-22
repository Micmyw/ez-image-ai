"use client";

import { SessionProvider } from "@auth/components/SessionProvider";
import dynamic from "next/dynamic";
import type { PropsWithChildren } from "react";

import { ConfirmationAlertProvider } from "./ConfirmationAlertProvider";

// Public routes also reference the registered server boundary. Keep organization
// tools out of their initial scripts, while retaining SSR for registered users.
const ActiveOrganizationProvider = dynamic(() =>
	import("@organizations/components/ActiveOrganizationProvider").then(
		(module) => module.ActiveOrganizationProvider,
	),
);

export function RegisteredWorkspaceProviders({ children }: PropsWithChildren) {
	return (
		<SessionProvider>
			<ActiveOrganizationProvider>
				<ConfirmationAlertProvider>{children}</ConfirmationAlertProvider>
			</ActiveOrganizationProvider>
		</SessionProvider>
	);
}
