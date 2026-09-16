"use client";

import { createContext, useContext } from "react";

import type { UpgradeSelection } from "../lib/upgrade-selection";

export const UpgradeContext = createContext<((selection: UpgradeSelection) => void) | null>(null);
export const useUpgrade = () => useContext(UpgradeContext);
