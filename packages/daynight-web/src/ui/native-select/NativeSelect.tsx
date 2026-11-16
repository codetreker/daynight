import type { ComponentPropsWithRef } from "react";
import "./native-select.css";

export type NativeSelectProps = Omit<ComponentPropsWithRef<"select">, "className" | "style"> & {
  readonly density?: "compact" | "filter" | "form";
  readonly layout?: "content" | "fill";
  readonly focusTone?: "default" | "task";
  readonly touchMode?: "none" | "responsive" | "container";
  readonly pending?: boolean;
  readonly wrapperClassName?: string;
};

export const NativeSelect = ({
  density = "form", layout = "content", focusTone = "default", touchMode = "none",
  pending = false, wrapperClassName, hidden, dir, multiple, size, children, ...props
}: NativeSelectProps) => {
  const list = multiple === true || (size !== undefined && size > 1);
  return <span className={wrapperClassName === undefined ? "native-select" : `native-select ${wrapperClassName}`}
    data-density={density} data-layout={layout} data-focus-tone={focusTone}
    data-touch-mode={touchMode} data-pending={pending} data-mode={list ? "list" : "popup"}
    hidden={hidden} dir={dir}>
    <select {...props} className="native-select__control" hidden={hidden} dir={dir} multiple={multiple} size={size}>
      {children}
    </select>
    {!list && <svg className="native-select__arrow" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>}
  </span>;
};

export const isNativeSelectPopupOpen = (target: EventTarget | null): boolean =>
  target instanceof HTMLSelectElement && target.matches(":open");
