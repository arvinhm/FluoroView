import type { Box } from "./geometry";

export type ViewerCommand = "zoom-in" | "zoom-out" | "fit" | "actual";

const bus = new EventTarget();

export function runViewerCommand(command: ViewerCommand): void {
  bus.dispatchEvent(new CustomEvent<ViewerCommand>("command", { detail: command }));
}

export function onViewerCommand(handler: (command: ViewerCommand) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ViewerCommand>).detail);
  bus.addEventListener("command", listener);
  return () => bus.removeEventListener("command", listener);
}

/** Fly the viewer so the image box (full-resolution pixels) fills the view with a margin. */
export function focusViewer(box: Box): void {
  bus.dispatchEvent(new CustomEvent<Box>("focus", { detail: box }));
}

export function onViewerFocus(handler: (box: Box) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<Box>).detail);
  bus.addEventListener("focus", listener);
  return () => bus.removeEventListener("focus", listener);
}
