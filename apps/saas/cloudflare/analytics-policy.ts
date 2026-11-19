import {
	resolveAnalyticsPolicy,
	setAnalyticsPolicyPrivacyHeaders,
} from "@repo/utils/lib/analytics-policy";

import { setPublicDataSecurityHeaders } from "./public-data-headers";

export interface AnalyticsPolicyEnvironment {
	MEDIA_TRUSTED_PROXY_PROVIDER?: string;
	ANALYTICS_OPT_OUT_COUNTRIES?: string;
}

export function serveAnalyticsPolicy(
	request: Request,
	environment: AnalyticsPolicyEnvironment,
	canonicalOrigin: string,
): Response | null {
	if (
		request.method !== "GET" ||
		request.body ||
		request.url !== `${canonicalOrigin}/api/analytics/policy`
	)
		return null;
	const origin = request.headers.get("Origin");
	if (origin && origin !== canonicalOrigin) return null;

	const headers = new Headers({ "Access-Control-Expose-Headers": "Content-Length" });
	setAnalyticsPolicyPrivacyHeaders(headers);
	setPublicDataSecurityHeaders(headers, request.url.startsWith("https://"));
	headers.append("Vary", "Origin");
	if (origin) headers.set("Access-Control-Allow-Origin", origin);

	return Response.json(
		resolveAnalyticsPolicy(request.headers, {
			MEDIA_TRUSTED_PROXY_PROVIDER: environment.MEDIA_TRUSTED_PROXY_PROVIDER,
			ANALYTICS_OPT_OUT_COUNTRIES: environment.ANALYTICS_OPT_OUT_COUNTRIES,
		}),
		{ headers },
	);
}
