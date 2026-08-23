import { SightengineSafetyAdapter, type SightengineOptions } from "./sightengine";
import { TestMediaSafetyAdapter } from "./test-adapter";
import type { MediaSafetyAdapter } from "./types";
export * from "./sightengine";
export * from "./test-adapter";
export * from "./types";
export type SafetyAdapterSelection =
	| { kind: "test"; nodeEnv: "development" | "test" | "production" }
	| ({ kind: "sightengine"; nodeEnv: "development" | "test" | "production" } & SightengineOptions);
export function createMediaSafetyAdapter(selection: SafetyAdapterSelection): MediaSafetyAdapter {
	if (selection.kind === "test") {
		if (selection.nodeEnv === "production")
			throw new Error("The test safety adapter is forbidden in production");
		return new TestMediaSafetyAdapter();
	}
	return new SightengineSafetyAdapter(selection);
}
