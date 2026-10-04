/** Callback tokens and private playback grants must never enter access logs. */
export function redactVideoAccessLog(message: string): string {
	return message
		.replace(/(\/webhooks\/video\/kie\/)[^\s?]+(?:\?[^\s]*)?/g, "$1[redacted]")
		.replace(/(\/webhooks\/video-v1\/seeapi\/)[^\s?]+(?:\?[^\s]*)?/g, "$1[redacted]")
		.replace(/(\/video-v1\/jobs\/[^/\s]+\/content)\?[^\s]*/g, "$1?[redacted]");
}
