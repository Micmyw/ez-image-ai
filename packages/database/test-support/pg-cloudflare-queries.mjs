// Shared read-only query plans for native Node and actual workerd transports.
export async function measureQueries(client, repeats, snapshot) {
	const samples = [];
	const measured = async (phase, index, text, values, name) => {
		const before = snapshot();
		const started = performance.now();
		const result = await client.query({ text, values, name });
		const elapsedMs = performance.now() - started;
		const after = snapshot();
		if (text.startsWith("SELECT") && (result.rows.length !== 1 || result.rows[0].value !== index)) {
			throw new Error(`BAD_RESULT_${phase}_${index}`);
		}
		return {
			phase,
			index,
			elapsedMs,
			writerCalls: after.writerCalls - before.writerCalls,
			writerBytes: after.writerBytes - before.writerBytes,
		};
	};
	const metadata = (
		await client.query(`SELECT current_database() AS database,
    current_setting('transaction_read_only') AS read_only,
    current_setting('ssl') AS server_ssl, pg_backend_pid() AS pid`)
	).rows[0];
	if (metadata.read_only !== "on") throw new Error("READ_ONLY_SESSION_REQUIRED");
	for (const phase of ["simple", "parameterized", "prepared", "transaction"]) {
		for (let index = -3; index < repeats; index++) {
			if (phase === "transaction") {
				const before = snapshot();
				const started = performance.now();
				const statements = [];
				try {
					statements.push(await measured("begin", index, "BEGIN READ ONLY"));
					statements.push(
						await measured("select-1", index, "SELECT $1::integer AS value", [index]),
					);
					statements.push(
						await measured("select-2", index, "SELECT $1::integer AS value", [index]),
					);
					statements.push(await measured("commit", index, "COMMIT"));
				} catch (error) {
					await client.query("ROLLBACK").catch(() => {});
					throw error;
				}
				const after = snapshot();
				if (index >= 0)
					samples.push({
						phase,
						index,
						elapsedMs: performance.now() - started,
						writerCalls: after.writerCalls - before.writerCalls,
						writerBytes: after.writerBytes - before.writerBytes,
						statements,
					});
			} else {
				const sample = await measured(
					phase,
					index,
					phase === "simple" ? `SELECT ${index}::integer AS value` : "SELECT $1::integer AS value",
					phase === "simple" ? undefined : [index],
					phase === "prepared" ? "pg_socket_regression" : undefined,
				);
				if (index >= 0) samples.push(sample);
			}
		}
	}
	return { metadata, samples };
}

export function summarize(samples) {
	const summary = {};
	for (const phase of new Set(samples.map((sample) => sample.phase))) {
		const selected = samples.filter((sample) => sample.phase === phase);
		const timings = selected.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
		const percentile = (p) =>
			timings[Math.min(timings.length - 1, Math.ceil(timings.length * p) - 1)];
		summary[phase] = {
			count: timings.length,
			minMs: timings[0],
			p50Ms: percentile(0.5),
			p95Ms: percentile(0.95),
			maxMs: timings.at(-1),
			meanMs: timings.reduce((sum, value) => sum + value, 0) / timings.length,
			writerCallsPerOperation: [...new Set(selected.map((sample) => sample.writerCalls))],
			writerBytesPerOperation: [...new Set(selected.map((sample) => sample.writerBytes))],
		};
	}
	return summary;
}
