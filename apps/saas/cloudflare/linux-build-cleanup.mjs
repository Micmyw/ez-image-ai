/** Only report absence after a successful daemon query, never an inspect error. */
export async function removeOwnedBuildContainer(command, { containerId, containerName }) {
	const identity = await command("docker", ["inspect", "--format", "{{.Id}}", containerName], {
		capture: true,
		allowFailure: true,
	});
	if (identity.status !== 0) {
		const remaining = await command(
			"docker",
			[
				"container",
				"ls",
				"--all",
				"--no-trunc",
				"--filter",
				`id=${containerId}`,
				"--format",
				"{{.ID}}",
			],
			{ capture: true, allowFailure: true },
		);
		if (remaining.status === 0 && remaining.output === "") return;
		throw new Error("LINUX_BUILD_CONTAINER_CLEANUP_UNCONFIRMED");
	}
	if (identity.output !== containerId) throw new Error("LINUX_BUILD_CONTAINER_IDENTITY_CHANGED");
	await command("docker", ["rm", "--force", containerId], { capture: true });
}
