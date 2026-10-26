"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={buttonClass("ghost", "sm")}
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : label}
    </button>
  );
}
