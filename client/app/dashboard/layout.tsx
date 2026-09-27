// app/dashboard/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cratedigger 🎛️",
  description: "Track request control center",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
