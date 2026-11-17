/** Result editing needs only public preset choices from the immutable accepted prompt. */
export function publicToolPrompt(prompt: string | undefined): string | undefined {
	if (!prompt) return undefined;
	const header =
		/^Coastal artwork preset gta-coastal-v1\. Task (wallpaper|loading-art)\. Scene (beach-sunset|neon-boulevard|sports-car|rooftop|marina|palm-road)\. Input (photo|scene)\. Format (phone|desktop)\. Portrait (left|right)\./.exec(
			prompt,
		);
	if (!header || (header[1] === "loading-art" && header[3] !== "photo")) return undefined;
	return header[0];
}
