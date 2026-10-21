import type { recordGrowthEvent } from "@repo/database";
import { acquisitionSource, analyticsDevice } from "@repo/utils/lib/analytics-dimensions";
import { resolveAnalyticsPolicy } from "@repo/utils/lib/analytics-policy";
import {
	hasGrowthAnalyticsConsent,
	readGrowthAnalyticsSessionHash,
} from "@repo/utils/lib/growth-analytics-cookie";

import { isAnonymousUser, type BetterAuthUserBoundary } from "./anonymous-boundary";
import {
	getRegistrationAttributionSnapshot,
	isRegistrationCreationPath,
	type RegistrationRequestContext,
} from "./registration-attribution";

/** Called only from Better Auth's server user-create hook, never from browser analytics input. */
export async function persistRegistrationConversion(
	user: BetterAuthUserBoundary & { role?: string | null },
	context: RegistrationRequestContext | null | undefined,
	dependencies: {
		origin: string;
		now?: Date;
		save: (event: Parameters<typeof recordGrowthEvent>[0]) => Promise<unknown>;
	},
) {
	if (
		!user.id ||
		isAnonymousUser(user) ||
		!isRegistrationCreationPath(context?.path, context?.params?.id)
	)
		return false;
	const headers = context?.headers ?? context?.request?.headers;
	const cookie = headers?.get("cookie") ?? "";
	const sessionHash = readGrowthAnalyticsSessionHash(cookie);
	if (
		!headers ||
		!resolveAnalyticsPolicy(headers).analyticsAllowed ||
		!hasGrowthAnalyticsConsent(cookie) ||
		!sessionHash
	)
		return false;
	const attribution = getRegistrationAttributionSnapshot(
		context,
		dependencies.origin,
		dependencies.now,
	);
	await dependencies.save({
		id: `registration:${user.id}`,
		sessionHash,
		userId: user.id,
		internal: user.role === "admin",
		// Deliberately absent from the browser event-name schema.
		name: "registration_confirmed",
		path: null,
		source: acquisitionSource(attribution),
		medium: attribution?.utmMedium ?? null,
		campaign: attribution?.utmCampaign ?? null,
		device: analyticsDevice(headers?.get("user-agent") ?? ""),
		productKind: null,
		errorCategory: null,
	});
	return true;
}
