/** Lightweight exact public destinations; no catalog, draft, prompt or provider imports. */
export function isSourceVideoTemplatePath(path: string): boolean {
	return /^\/video-templates\/(?:original-rap|rap-orange-studio|rap-street-cypher|rap-neon-rap|rap-funny-rap|bulin-47|spin-me-round|58th-floor|green-booth-freestyle|kung-fu-cat|paws-at-you|source-hotel-lobby|flying-car-curved-ramp(?:-showcase)?|flying-car-fleet-side|flying-car-fleet-front)$/.test(
		path,
	);
}
