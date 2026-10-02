import type { ReactNode } from "react";
import { Button } from "./ui";

/** Bottom-sheet style modal — reachable with a thumb on a phone. */

export function Modal({
  title,
  onClose,
  children,
  showClose = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  showClose?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 pb-8 dark:bg-slate-900 sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">
            {title}
          </h2>
          {showClose && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </Button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
