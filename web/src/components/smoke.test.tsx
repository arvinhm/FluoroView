import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import Toaster from "./Toaster";
import ErrorBoundary from "./ErrorBoundary";
import { EmptyState } from "./ui";
import { toast, useToasts } from "../lib/toast";

afterEach(() => {
  cleanup();
  useToasts.setState({ toasts: [] });
});

describe("EmptyState", () => {
  it("renders its title and hint", () => {
    render(<EmptyState title="No data" hint="Load a dataset" />);
    expect(screen.getByText("No data")).toBeTruthy();
    expect(screen.getByText("Load a dataset")).toBeTruthy();
  });
});

describe("Toaster", () => {
  it("displays a toast pushed via the imperative helper", () => {
    render(<Toaster />);
    act(() => {
      toast.success("Saved", "All good");
    });
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("All good")).toBeTruthy();
  });
});

const Boom = (): never => {
  throw new Error("kaboom");
};

describe("ErrorBoundary", () => {
  it("renders a graceful fallback when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    spy.mockRestore();
  });
});
