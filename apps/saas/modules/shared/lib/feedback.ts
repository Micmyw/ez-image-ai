import { JOURNEY_FEEDBACK_TOPICS } from "@repo/config/generation-journey";

export type FeedbackKind = "idea" | "bug";
export type FeedbackTopic = (typeof JOURNEY_FEEDBACK_TOPICS)[number];
export { JOURNEY_FEEDBACK_TOPICS as FEEDBACK_TOPICS };

export function normalizeFeedbackTopic(value: unknown): FeedbackTopic | undefined {
	return typeof value === "string" && (JOURNEY_FEEDBACK_TOPICS as readonly string[]).includes(value)
		? (value as FeedbackTopic)
		: undefined;
}

/** The selected category is part of the customer's voluntary support message, not a new channel. */
export function feedbackTicketSubject(subject: string, topic?: FeedbackTopic): string {
	const prefix = topic ? `[Feedback: ${topic}] ` : "";
	return `${prefix}${subject.trim().slice(0, 200 - prefix.length)}`;
}

export function buildFeedbackMailto(
	supportEmail: string,
	input: { kind: FeedbackKind; accountEmail: string; description: string; topic?: FeedbackTopic },
	labels: { subjectIdea: string; subjectBug: string; accountEmail: string; description: string },
) {
	const subject = feedbackTicketSubject(
		input.kind === "bug" ? labels.subjectBug : labels.subjectIdea,
		input.topic,
	);
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
