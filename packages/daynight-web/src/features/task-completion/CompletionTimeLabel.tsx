import type { ComponentProps } from "react";
import type { CompletionValue } from "./useCompletionTime";
import "./completion.css";

export const CompletionTimeLabel = ({ value, ...events }: { readonly value: CompletionValue | null } & Pick<ComponentProps<"time">, "onPointerEnter" | "onPointerLeave">) =>
  value === null ? null : <time className="completion-time-label" dateTime={value.timestamp} aria-hidden="true" {...events}>{value.label}</time>;
