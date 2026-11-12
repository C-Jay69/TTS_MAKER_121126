"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/** Top-level error boundary so a render crash never blanks the studio. */
export class StudioErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Studio crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-destructive/15">
            <AlertTriangle className="size-7 text-destructive" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-slate-100">The studio hit an unexpected error</h2>
            <p className="max-w-md text-sm text-slate-400">
              {this.state.message || "Something went wrong while rendering the interface."}
            </p>
          </div>
          <Button onClick={() => window.location.reload()} variant="secondary">
            Reload the studio
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
