/** Explicitly named, disposable databases used for video V1 final regression. */
export function isExplicitVideoVerificationTarget(target: URL): boolean {
	const approved = process.env.VIDEO_VERIFICATION_DATABASE_URL;
	if (!approved) return false;
	try {
		return (
			["postgres:", "postgresql:"].includes(target.protocol) &&
			["127.0.0.1", "localhost"].includes(target.hostname) &&
			target.port === "55439" &&
			["/ezpic_video_v1_final_test", "/ezpic_video_v1_e2e_test"].includes(target.pathname) &&
			target.href === new URL(approved).href
		);
	} catch {
		return false;
	}
}
