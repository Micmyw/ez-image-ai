"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib";

/** Base UI `Select.Root`. Pass `items` ({ value, label }[]) so `SelectValue` shows labels, not raw values. */
const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

const SelectTrigger = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) => (
	<SelectPrimitive.Trigger
		className={cn(
			"h-9 shadow-xs px-3 py-2 text-base flex w-full items-center justify-between rounded-md border border-input bg-card ring-offset-background placeholder:text-foreground/60 focus:ring-1 focus:ring-ring focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
	>
		{children}
		<SelectPrimitive.Icon render={<ChevronsUpDownIcon className="size-4 opacity-50" />} />
	</SelectPrimitive.Trigger>
);

const SelectContent = ({
	className,
	children,
	sideOffset = 4,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
	sideOffset?: number;
}) => (
	<SelectPrimitive.Portal>
		<SelectPrimitive.Positioner
			side="bottom"
			sideOffset={sideOffset}
			align="center"
			className="z-50"
		>
			<SelectPrimitive.Backdrop />
			<SelectPrimitive.Popup
				className={cn(
					"data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 shadow-md data-[closed]:animate-out data-[open]:animate-in relative z-50 min-w-(--anchor-width) overflow-hidden rounded-lg border bg-popover text-popover-foreground",
					className,
				)}
				{...props}
			>
				<SelectPrimitive.List className="scroll-py-1 p-1 max-h-[min(24rem,var(--available-height))] outline-none">
					{children}
				</SelectPrimitive.List>
			</SelectPrimitive.Popup>
		</SelectPrimitive.Positioner>
	</SelectPrimitive.Portal>
);

const SelectLabel = ({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) => (
	<SelectPrimitive.Label
		className={cn("px-2 py-1.5 font-semibold text-sm", className)}
		{...props}
	/>
);

const SelectItem = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) => (
	<SelectPrimitive.Item
		className={cn(
			"py-1.5 pr-8 pl-2 text-sm relative flex w-full cursor-default items-center rounded-md outline-hidden select-none focus:bg-accent focus:text-accent-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50",
			className,
		)}
		{...props}
	>
		<span className="right-2 size-3.5 absolute flex items-center justify-center">
			<SelectPrimitive.ItemIndicator>
				<CheckIcon className="size-4" />
			</SelectPrimitive.ItemIndicator>
		</span>
		<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
	</SelectPrimitive.Item>
);

const SelectSeparator = ({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) => (
	<SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
);

export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
};
