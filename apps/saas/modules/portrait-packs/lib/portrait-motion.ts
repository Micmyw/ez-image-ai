export type TearAxis = "pending" | "horizontal" | "vertical";

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function sampleTear(axis: TearAxis, dx: number, dy: number, width: number) {
	if (axis === "pending" && Math.max(Math.abs(dx), Math.abs(dy)) >= 9) {
		axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
	}
	const progress = axis === "horizontal" ? clamp(Math.abs(dx) / Math.max(1, width)) : 0;
	return { axis, progress, reverse: progress > 0 && dx < 0, complete: progress >= 0.62 };
}

export function foilLight(
	clientX: number,
	clientY: number,
	{ left, top, width, height }: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
	const x = clamp((clientX - left) / Math.max(1, width));
	const y = clamp((clientY - top) / Math.max(1, height));
	return {
		x: `${Math.round(x * 100)}%`,
		y: `${Math.round(y * 100)}%`,
		tiltX: `${Math.round((0.5 - y) * 20)}deg`,
		tiltY: `${Math.round((x - 0.5) * 20)}deg`,
	};
}
