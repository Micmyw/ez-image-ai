"use client";

import { useEffect, useSyncExternalStore } from "react";

import { createPaymentActionController } from "../lib/payment-action";

const controller = createPaymentActionController();
const serverSnapshot = () => null;

export function usePaymentAction() {
	const action = useSyncExternalStore(controller.subscribe, controller.getSnapshot, serverSnapshot);
	useEffect(() => {
		const restore = (event: PageTransitionEvent) => {
			if (event.persisted) controller.release();
		};
		window.addEventListener("pageshow", restore);
		return () => window.removeEventListener("pageshow", restore);
	}, []);
	return { action, ...controller };
}
