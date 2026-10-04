/** Explicitly named, disposable databases used for video V1 final regression. */
export function isExplicitVideoVerificationTarget(target: URL): boolean {
	const approved = process.env.VIDEO_VERIFICATION_DATABASE_URL;
	if (!approved) return false;
	try {
		// Disposable fixtures may use another high port when a parallel task owns the default.
		// The full URI must still be explicitly selected below; normal PostgreSQL ports stay denied.
		const port = Number(target.port);
		return (
			["postgres:", "postgresql:"].includes(target.protocol) &&
			["127.0.0.1", "localhost"].includes(target.hostname) &&
			target.search === "" &&
			target.hash === "" &&
			Number.isInteger(port) &&
			port >= 49152 &&
			port <= 65535 &&
			["/ezpic_video_v1_final_test", "/ezpic_video_v1_e2e_test"].includes(target.pathname) &&
			target.href === new URL(approved).href
		);
	} catch {
		return false;
	}
}
