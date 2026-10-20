import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => ({
	back: undefined as (() => void) | undefined,
	select: undefined as ((jobId: string) => void) | undefined,
	newResult: undefined as (() => void) | undefined,
	user: { id: "owner" } as { id: string } | null,
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: callbacks.user }) }));
vi.mock("@media/components/editor/EditorResultPanel", () => ({
	EditorResultPanel: ({ jobId, onNew }: { jobId: string; onNew: () => void }) => {
		callbacks.newResult = onNew;
		return <div>Result: {jobId}</div>;
	},
}));
vi.mock("@media/components/JobHistory", () => ({
	JobHistory: ({ onSelect }: { onSelect: (jobId: string) => void }) => {
		callbacks.select = onSelect;
		return <div>History list</div>;
	},
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => {
		callbacks.back = onClick;
		return <button onClick={onClick}>{children}</button>;
	},
}));
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) =>
		namespace === "media.detail" && key === "back" ? "Back to history" : key,
}));

import { HistoryDetailPanel } from "./panels/HistoryDetailPanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { StudioPanels, type StudioPanelProps } from "./StudioPanels";

describe("history panel navigation", () => {
	beforeEach(() => {
		callbacks.back = undefined;
		callbacks.select = undefined;
		callbacks.newResult = undefined;
		callbacks.user = { id: "owner" };
	});

	it("offers an explicit back action that returns to the list without closing the panel", () => {
		const onChange = vi.fn();
		const onClose = vi.fn();
		const props: StudioPanelProps = {
			panel: { kind: "history", jobId: "first-job" },
			onChange,
			onClose,
		};
		const markup = renderToStaticMarkup(<StudioPanels component={HistoryDetailPanel} {...props} />);
		expect(markup).toContain("Back to history");
		expect(markup).toContain("Result: first-job");
		callbacks.back?.();
		expect(onChange).toHaveBeenCalledWith({ kind: "history" });
		expect(onClose).not.toHaveBeenCalled();
		expect(
			renderToStaticMarkup(
				<StudioPanels component={HistoryPanel} {...props} panel={{ kind: "history" }} />,
			),
		).toContain("History list");
		callbacks.select?.("second-job");
		expect(onChange).toHaveBeenLastCalledWith({ kind: "history", jobId: "second-job" });
		callbacks.newResult?.();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("does not mount a cached panel component after the user signs out", () => {
		callbacks.user = null;
		const component = vi.fn(() => <div>Private content</div>);
		expect(
			renderToStaticMarkup(
				<StudioPanels
					component={component}
					panel={{ kind: "assets" }}
					onChange={vi.fn()}
					onClose={vi.fn()}
				/>,
			),
		).toBe("");
		expect(component).not.toHaveBeenCalled();
	});
});
