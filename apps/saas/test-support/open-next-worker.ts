// Vitest-only resolution target for the build-generated OpenNext Worker.
export default {
	fetch(): never {
		throw new Error("Mock the OpenNext Worker before exercising its entrypoint");
	},
};

export class DOQueueHandler {}
export class DOShardedTagCache {}
