import assert from "node:assert/strict";

/** Local V8 isolate measurements, never process RSS or a production capacity claim. */
export async function openWorkerMemoryProbe(runtime, workerName) {
	const inspector = await runtime.getInspectorURL();
	inspector.protocol = "http:";
	const targets = await (await fetch(new URL("/json/list", inspector))).json();
	const target = targets.find((entry) => entry.id === `core:user:${workerName}`);
	assert(target, "Expected the website isolate inspector");
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let sequence = 0;
	const pending = new Map();
	socket.addEventListener("message", ({ data }) => {
		const message = JSON.parse(data);
		if (!message.id) return; // Snapshot chunks are discarded; no request data is retained.
		const operation = pending.get(message.id);
		if (!operation) return;
		pending.delete(message.id);
		clearTimeout(operation.timer);
		if (message.error) operation.reject(new Error("WORKER_MEMORY_INSPECTOR_FAILED"));
		else operation.resolve(message.result);
	});
	const close = () => {
		for (const operation of pending.values()) {
			clearTimeout(operation.timer);
			operation.reject(new Error("WORKER_MEMORY_INSPECTOR_CLOSED"));
		}
		pending.clear();
		socket.close();
	};
	const command = (method) =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("WORKER_MEMORY_INSPECTOR_TIMEOUT"));
			}, 30_000);
			pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify({ id, method }));
		});
	return {
		close,
		async measure(stage, limitMiB, { retained = false } = {}) {
			if (retained) {
				await command("HeapProfiler.enable");
				await command("HeapProfiler.takeHeapSnapshot");
			}
			const memory = await command("Runtime.getHeapUsage");
			const bytes = memory.usedSize + memory.backingStorageSize;
			console.log(JSON.stringify({ stage, localIsolateMemory: memory, budgetMiB: limitMiB }));
			assert(bytes < limitMiB * 1024 * 1024, `${stage}: website isolate memory budget exceeded`);
			return memory;
		},
	};
}
