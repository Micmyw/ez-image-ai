"use client";

import { useEffect, useState } from "react";

export function usePageVisible() {
	const [visible, setVisible] = useState(true);
	useEffect(() => {
		if (typeof document === "undefined") return;
		const update = () => setVisible(document.visibilityState === "visible");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}
