// Configure Zod before application modules create schemas. Its CSP capability
// probe otherwise attempts new Function even though the browser blocks eval.
// Zod shares this configuration across its CJS/ESM and split bundle instances.
const browserGlobals = globalThis as typeof globalThis & {
	__zod_globalConfig?: { jitless?: boolean };
};
browserGlobals.__zod_globalConfig ??= {};
browserGlobals.__zod_globalConfig.jitless = true;
