import assert from "node:assert/strict";

const denialCause = /blocked by restrictPeers|restricted|not allowed|disallowed/i;

/** HTTP responses and stderr use independent pipes; wait for the matching complete log record. */
export async function assertWorkerdNetworkDenied(
	message,
	{ runtime, readLogs, timeoutMs = 3_000 },
) {
	const reference = message.match(/reference = (\S+)/)?.[1];
	if (!reference) {
		assert.match(message, /restricted|not allowed|permission|private|disallowed/i);
		return;
	}

	await new Promise((resolve, reject) => {
		let timeout;
		const cleanup = () => {
			clearTimeout(timeout);
			runtime.stderr.off("data", inspect);
			runtime.stderr.off("end", ended);
			runtime.stderr.off("close", ended);
			runtime.stderr.off("error", failed);
			runtime.off("close", ended);
			runtime.off("error", failed);
		};
		const failed = (error) => {
			cleanup();
			reject(error);
		};
		const missing = (reason) =>
			new Error(`Missing workerd network-denial evidence for ${reference}: ${reason}`);
		const ended = () => failed(missing("runtime or stderr closed"));
		const inspect = () => {
			// A chunk can stop halfway through the ID. Only newline-terminated records count.
			const lines = readLogs().split(/\r?\n/);
			lines.pop();
			const errorLine = lines.findIndex(
				(line) => line.match(/\bwdErrId = (\S+)/)?.[1] === reference,
			);
			if (errorLine < 0) return;
			try {
				assert.match(lines[errorLine - 1] ?? "", denialCause);
				cleanup();
				resolve();
			} catch (error) {
				failed(error);
			}
		};
		runtime.stderr.on("data", inspect);
		runtime.stderr.once("end", ended);
		runtime.stderr.once("close", ended);
		runtime.stderr.once("error", failed);
		runtime.once("close", ended);
		runtime.once("error", failed);
		timeout = setTimeout(() => failed(missing("deadline exceeded")), timeoutMs);
		inspect();
		if (runtime.stderr.readableEnded || runtime.stderr.destroyed) ended();
	});
}
