import { isVideoModelOptionAllowed, readVideoModelAccess } from "@repo/config/video-model-access";
import { VIDEO_MODEL_CATALOG, getVideoModelOptions } from "@repo/config/video-models";
import { resolveVideoModelPrice } from "@repo/config/video-pricing.server";
import { videoV1Readiness, type VideoV1Bindings } from "@repo/config/video-v1";

// Aspect ratio has no separate retail rate/readiness. Keep legal ratio tuples in
// the public static catalogue; send each priced combination only once over HTTP.
const publicOptions = new Map(
	VIDEO_MODEL_CATALOG.map((model) => [
		model.productKey,
		[
			...new Map(
				model.modes.flatMap((mode) =>
					getVideoModelOptions(model.productKey, mode).map(({ aspectRatio: _ratio, ...option }) => {
						const value = { mode, ...option };
						return [JSON.stringify(value), value] as const;
					}),
				),
			).values(),
		],
	]),
);

export function buildVideoCatalogModels(
	environment: Record<string, string | undefined>,
	bindings: VideoV1Bindings,
	accessAllowed: boolean,
	disabledKeys: ReadonlySet<string>,
) {
	const modelAccess = readVideoModelAccess(environment);
	const readiness = new Map<boolean, ReturnType<typeof videoV1Readiness>>();
	const readReady = (sound: boolean) => {
		let ready = readiness.get(sound);
		if (!ready) {
			ready = videoV1Readiness(environment, bindings, { multiModel: true, sound });
			readiness.set(sound, ready);
		}
		return ready;
	};
	return VIDEO_MODEL_CATALOG.map((model) => {
		const commonReasons = accessAllowed ? [...readReady(false).reasons] : ["VIDEO_ACCESS_DENIED"];
		if (
			disabledKeys.has("media.generation.enabled") ||
			disabledKeys.has(`media.model.${model.productKey}.enabled`)
		)
			commonReasons.push("VIDEO_DISABLED");
		const options = !accessAllowed
			? []
			: publicOptions.get(model.productKey)!.map((option) => {
					// Model-wide gate reasons travel once; options carry only additional
					// sound/price reasons. `available` always reflects BOTH sets.
					const reasons = readReady(option.sound).reasons.filter(
						(reason) => !commonReasons.includes(reason),
					);
					if (!isVideoModelOptionAllowed(modelAccess, { productKey: model.productKey, ...option }))
						reasons.push(modelAccess.reason ?? "VIDEO_MODEL_OPTION_NOT_ENABLED");
					let credits: string | null = null;
					try {
						credits = resolveVideoModelPrice(
							{ productKey: model.productKey, ...option },
							environment,
						).credits.toString();
					} catch (error) {
						const reason = error instanceof Error ? error.message : "VIDEO_PRICE_NOT_CONFIGURED";
						reasons.push(
							/^[A-Z][A-Z0-9_]{2,80}$/.test(reason) ? reason : "VIDEO_PRICE_NOT_CONFIGURED",
						);
					}
					return {
						...option,
						available: commonReasons.length === 0 && reasons.length === 0,
						reasons: [...new Set(reasons)],
						credits,
					};
				});
		return {
			productKey: model.productKey,
			available: model.status === "implemented" && options.some((option) => option.available),
			commonReasons: [...new Set(commonReasons)],
			reasons: !accessAllowed
				? ["VIDEO_ACCESS_DENIED"]
				: model.status === "blocked"
					? [model.blockedReason ?? "VIDEO_MODEL_OPTION_UNAVAILABLE"]
					: [...new Set([...commonReasons, ...options.flatMap((option) => option.reasons)])],
			options,
		};
	});
}
