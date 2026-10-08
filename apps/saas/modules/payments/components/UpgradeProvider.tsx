"use client";

import { captureCheckoutTrigger, clearCheckoutTrigger } from "@shared/lib/purchase-attribution";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { parseUpgradeSelection, type UpgradeSelection } from "../lib/upgrade-selection";
import { UpgradeContext } from "./upgrade-context";

const UpgradeDialog = dynamic(() =>
	import("./UpgradeDialog").then((module) => module.UpgradeDialog),
);

export function UpgradeProvider({ children }: { children: ReactNode }) {
	const [selection, setSelection] = useState<UpgradeSelection | null>(null);
	const pathname = usePathname();
	useEffect(() => {
		setSelection(
			pathname === "/pricing"
				? parseUpgradeSelection(new URLSearchParams(window.location.search))
				: null,
		);
	}, [pathname]);
	return (
		<UpgradeContext.Provider
			value={(next) => {
				captureCheckoutTrigger();
				setSelection(next);
			}}
		>
			{children}
			{selection && (
				<UpgradeDialog
					selection={selection}
					onClose={() => {
						clearCheckoutTrigger();
						setSelection(null);
					}}
				/>
			)}
		</UpgradeContext.Provider>
	);
}
