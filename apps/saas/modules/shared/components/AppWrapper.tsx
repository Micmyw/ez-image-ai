"use client";

import { cn } from "@repo/ui";
import type { PropsWithChildren } from "react";

import { SidebarProvider, useSidebar } from "../lib/sidebar-context";
import { NavBar } from "./NavBar";

function AppContent({ children }: PropsWithChildren) {
	const { isCollapsed } = useSidebar();

	return (
		<div className="md:h-screen md:overflow-hidden bg-background">
			<NavBar />
			<div
				className={cn("flex h-screen", {
					"md:ml-[280px]": !isCollapsed,
					"md:ml-[80px]": isCollapsed,
				})}
			>
				<main className="md:border-l md:border-t-0 md:overflow-y-auto py-4 h-full w-full border-t">
					<div className="container">{children}</div>
				</main>
			</div>
		</div>
	);
}

export function AppWrapper({ children }: PropsWithChildren) {
	return (
		<SidebarProvider>
			<AppContent>{children}</AppContent>
		</SidebarProvider>
	);
}
