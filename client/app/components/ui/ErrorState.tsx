"use client";

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="border border-error">
      <div className="bg-error text-on-error px-gutter py-stack-sm flex items-center gap-1">
        <span className="material-symbols-outlined text-[14px]">error</span>
        <span className="font-label-mono text-label-mono">ERROR</span>
      </div>
      <div className="px-gutter py-stack-md">
        <p className="font-body-sm text-body-sm text-on-surface mb-stack-md">{message}</p>
        <button
          onClick={onRetry}
          className="font-label-caps text-label-caps border border-primary px-6 py-stack-sm hover:bg-primary hover:text-on-primary transition-none"
        >
          TRY AGAIN
        </button>
      </div>
    </div>
  );
}
