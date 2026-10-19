export type FeedbackKind = "idea" | "bug";

export function buildFeedbackMailto(
	supportEmail: string,
	input: { kind: FeedbackKind; accountEmail: string; description: string },
	labels: { subjectIdea: string; subjectBug: string; accountEmail: string; description: string },
) {
	const subject = input.kind === "bug" ? labels.subjectBug : labels.subjectIdea;
	const body = `${labels.accountEmail}: ${input.accountEmail.trim()}\n\n${labels.description}:\n${input.description}`;
	return `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export async function copyFeedbackEmail(
	email: string,
	clipboard: Pick<Clipboard, "writeText"> | undefined,
) {
	try {
		if (!clipboard) return false;
		await clipboard.writeText(email);
		return true;
	} catch {
		return false;
	}
}

/** The timer also completes the reveal when animation events are unavailable. */
export function scheduleFeedbackReveal(reveal: () => void, reducedMotion: boolean) {
	if (reducedMotion) {
		reveal();
		return () => {};
	}
	const timer = setTimeout(reveal, 400);
	return () => clearTimeout(timer);
}
