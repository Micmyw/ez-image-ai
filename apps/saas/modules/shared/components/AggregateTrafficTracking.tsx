"use client";

import { useSessionQuery } from "@auth/lib/api";
import { aggregatePath, aggregateSource } from "@repo/utils/lib/aggregate-traffic";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export function AggregateTrafficTracking() {
	const pathname = usePathname();
	const { aggregateAllowed } = useCookieConsent();
	const session = useSessionQuery();
	const last = useRef<string | null>(null);
	const source = useRef<ReturnType<typeof aggregateSource> | null>(null);
	useEffect(() => {
		source.current ??= aggregateSource(location.href, document.referrer);
		if (
			!aggregateAllowed ||
			session.isPending ||
			session.data?.user.role === "admin" ||
			session.data?.session.impersonatedBy
		)
			return;
		const url = new URL(location.href);
		const path = aggregatePath(url);
		if (!path) {
			last.current = null;
			return;
		}
		// Dedupe this mounted page only. No persistent visitor or replay identity.
		if (last.current === url.pathname) return;
		last.current = url.pathname;
		void fetch("/api/analytics/traffic", {
			method: "POST",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			keepalive: true,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path, source: source.current }),
		}).catch(() => {});
	}, [pathname, aggregateAllowed, session.isPending, session.data]);
	return null;
}
