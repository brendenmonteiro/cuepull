"use client";

// Client-side redirect: the server-component redirect() form is a hard build
// error under output: "export".
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);
  return null;
}
