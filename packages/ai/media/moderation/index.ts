import { TestMediaSafetyAdapter } from "./test-adapter";
import type { MediaSafetyAdapter } from "./types";
export * from "./test-adapter";
export * from "./types";
export * from "./seeapi";
export * from "./configured";
export * from "./video-configured";
export * from "./seeapi-video";
export * from "./seeapi-video-webhook";
export type SafetyAdapterSelection = {
	kind: "test";
	nodeEnv: "development" | "test" | "production";
	allowTestAdapter: true;
};
export function createMediaSafetyAdapter(selection: SafetyAdapterSelection): MediaSafetyAdapter {
	if (selection.kind !== "test") throw new Error("Unsupported media safety adapter");
	if (selection.nodeEnv === "production")
		throw new Error("The test safety adapter is forbidden in production");
	if (
		(selection.nodeEnv !== "test" && selection.nodeEnv !== "development") ||
		selection.allowTestAdapter !== true
	)
		throw new Error("The test safety adapter requires an explicitly enabled local environment");
	return new TestMediaSafetyAdapter();
}
