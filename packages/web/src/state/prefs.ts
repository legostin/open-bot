// View preferences of this browser (not hub settings), kept in localStorage.

import { createStore } from "../lib/store";

const DETAILS = "ob.chat.details";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Detailed mode: the chat also shows tool calls and results, notes for the model and which brain answered. */
export const showDetails = createStore<boolean>(read(DETAILS));

export function setShowDetails(on: boolean): void {
  showDetails.set(on);
  try {
    localStorage.setItem(DETAILS, on ? "1" : "0");
  } catch {
    /* private mode: the choice lasts until reload */
  }
}
