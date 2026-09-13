"use client";

import { Button } from "@repo/ui/components/button";
import { Component, type ReactNode } from "react";

export class StudioPanelBoundary extends Component<
	{
		children: ReactNode;
		errorLabel: string;
		retryLabel: string;
	},
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		if (this.state.failed)
			return (
				<div role="alert">
					<p className="text-sm">{this.props.errorLabel}</p>
					<Button
						className="mt-3"
						variant="secondary"
						onClick={() => this.setState({ failed: false })}
					>
						{this.props.retryLabel}
					</Button>
				</div>
			);
		return this.props.children;
	}
}
