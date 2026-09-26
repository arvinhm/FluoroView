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
