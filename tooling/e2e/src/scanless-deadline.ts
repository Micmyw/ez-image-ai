/** The independent process watchdog also covers a blocked Node event loop. */
export function withinScanlessDeadline<T>(
	stage: string,
	operation: PromiseLike<T>,
	milliseconds: number,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`SCANLESS_STAGE_TIMEOUT:${stage}`)),
			milliseconds,
		);
		Promise.resolve(operation).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
