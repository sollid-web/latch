import { createFileRoute } from "@tanstack/react-router";
import { LatchApp } from "@/components/latch/shell";

export const Route = createFileRoute("/")({
  component: LatchApp,
});
