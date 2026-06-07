"use client";
export function RequestingState() {
  return (
    <div className="py-stack-sm">
      <div className="loader-line w-full mb-stack-sm" />
      <p className="font-label-mono text-label-mono text-secondary">CONNECTING...</p>
    </div>
  );
}
