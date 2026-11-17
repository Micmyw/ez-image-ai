export function selectUnitCommands<T extends { args: string[] }>(
	commands: T[],
	selection = process.env.CI_UNIT_WORKSPACES,
): T[] {
	if (selection === undefined) return commands;
	const workspaces: unknown = JSON.parse(selection);
	if (workspaces === null) return commands;
	if (!Array.isArray(workspaces) || workspaces.some((name) => typeof name !== "string")) {
		throw new Error("INVALID_CI_UNIT_WORKSPACES");
	}
	return commands.filter(({ args }) => {
		const filterIndex = args.indexOf("--filter");
		const workspace =
			filterIndex >= 0
				? args[filterIndex + 1]
				: {
						"hotel-lobby:test-config": "@repo/config",
						"verify:ui-originality:self-test": "saas",
					}[args[0]!];
		if (!workspace) throw new Error(`UNCLASSIFIED_UNIT_COMMAND: ${args.join(" ")}`);
		return workspaces.includes(workspace);
	});
}
