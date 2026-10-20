"use client";

import { useEffect, useRef, useState } from "react";

export function observeNearViewport(element: Element, update: (visible: boolean) => void) {
	if (typeof IntersectionObserver === "undefined") {
		update(true);
		return () => {};
	}
	const observer = new IntersectionObserver(
		(entries) => update(entries.some((entry) => entry.isIntersecting)),
		{ rootMargin: "240px" },
	);
	observer.observe(element);
	return () => observer.disconnect();
}

export function useNearViewport() {
	const ref = useRef<HTMLDivElement>(null);
	const [nearViewport, setNearViewport] = useState(false);
	useEffect(() => {
		if (!ref.current) return;
		return observeNearViewport(ref.current, setNearViewport);
	}, []);
	return { ref, nearViewport };
}
