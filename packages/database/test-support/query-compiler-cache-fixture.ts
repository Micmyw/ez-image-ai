export interface CompilerOptions {
	datamodel: string;
	provider: string;
	connectionInfo: {
		schemaName?: string;
		maxBindValues?: number;
		supportsRelationJoins?: boolean;
	};
}

export interface CompilerFacade {
	compile(query: string): unknown;
	compileBatch(query: string): unknown;
	free(): void;
}

export type CompilerConstructor = new (options: CompilerOptions) => CompilerFacade;
export type ReuseCompiler = (
	constructor: CompilerConstructor,
	options: CompilerOptions,
	transformInitError?: (error: unknown) => unknown,
) => CompilerFacade;

export function compilerOptions(): CompilerOptions {
	return {
		datamodel: "model CacheProbe { id Int @id owner String }",
		provider: "postgresql",
		connectionInfo: { schemaName: "public", maxBindValues: 32766, supportsRelationJoins: true },
	};
}

interface Hooks {
	construct?(options: CompilerOptions, attempt: number): void;
	compile?(instance: FakeCompiler, query: string): void;
	compileBatch?(instance: FakeCompiler, query: string): void;
	free?(instance: FakeCompiler): void;
}

interface FakeCompiler extends CompilerFacade {
	readonly id: number;
	readonly options: CompilerOptions;
	freed: boolean;
}

/** An observable compiler boundary, not a second implementation of the cache. */
export function compilerFixture(hooks: Hooks = {}) {
	const state = {
		constructAttempts: 0,
		compileCalls: 0,
		batchCalls: 0,
		freeAttempts: 0,
		useAfterFree: 0,
		instances: [] as FakeCompiler[],
	};
	class Compiler implements FakeCompiler {
		readonly id: number;
		freed = false;
		constructor(readonly options: CompilerOptions) {
			this.id = ++state.constructAttempts;
			hooks.construct?.(options, this.id);
			state.instances.push(this);
		}
		private alive() {
			if (!this.freed) return;
			state.useAfterFree++;
			throw new Error("FIXTURE_USE_AFTER_FREE");
		}
		compile(query: string) {
			this.alive();
			state.compileCalls++;
			hooks.compile?.(this, query);
			return { compilerId: this.id, query, plan: { method: "single", call: state.compileCalls } };
		}
		compileBatch(query: string) {
			this.alive();
			state.batchCalls++;
			hooks.compileBatch?.(this, query);
			return { compilerId: this.id, query, plan: { method: "batch", call: state.batchCalls } };
		}
		free() {
			this.alive();
			state.freeAttempts++;
			hooks.free?.(this);
			this.freed = true;
		}
	}
	return { Compiler, state };
}
