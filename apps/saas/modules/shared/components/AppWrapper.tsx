"use client";

import { cn } from "@repo/ui";
import type { PropsWithChildren } from "react";

import { SidebarProvider, useSidebar } from "../lib/sidebar-context";
import { NavBar } from "./NavBar";

function AppContent({ children }: PropsWithChildren) {
	const { isCollapsed } = useSidebar();

	return (
		<div
			data-app-shell="ezpic-workspace"
			className="md:h-screen md:overflow-hidden min-h-screen bg-[#120d1a]"
		>
			<NavBar />
			<div
				className={cn("md:h-screen md:min-h-0 flex min-h-[calc(100dvh-4.5rem)]", {
					"md:ml-[280px]": !isCollapsed,
					"md:ml-[80px]": isCollapsed,
				})}
			>
				<main className="py-5 md:overflow-y-auto md:rounded-tl-[1.75rem] md:border-l md:border-t-0 md:py-6 h-full w-full border-t border-[#ded6e8] bg-background shadow-[0_-22px_60px_-48px_rgba(108,77,255,0.8)]">
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
