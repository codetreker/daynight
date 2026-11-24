import type { ComponentPropsWithRef } from "react";
import type { SelectionControlPresentation } from '../selection-control/presentation';
import { SelectionArrow } from '../selection-control/SelectionArrow';
import '../selection-control/selection-control.css';
import "./native-select.css";

export type NativeSelectProps = Omit<ComponentPropsWithRef<"select">, "className" | "style"> & SelectionControlPresentation & {
  readonly layout?: "content" | "fill";
  readonly wrapperClassName?: string;
};

export const NativeSelect = ({
  density = "form", layout = "content", focusTone = "default", touchMode = "none", textSize = "sm",
  pending = false, wrapperClassName, hidden, dir, multiple, size, children, ...props
}: NativeSelectProps) => {
  const list = multiple === true || (size !== undefined && size > 1);
  return <span className={wrapperClassName === undefined ? "selection-control native-select" : `selection-control native-select ${wrapperClassName}`}
    data-density={density} data-layout={layout} data-focus-tone={focusTone} data-text-size={textSize}
    data-touch-mode={touchMode} data-pending={pending} data-mode={list ? "list" : "popup"}
    hidden={hidden} dir={dir}>
    <select {...props} className="native-select__control" hidden={hidden} dir={dir} multiple={multiple} size={size}>
      {children}
    </select>
    {!list && <SelectionArrow className="native-select__arrow" />}
  </span>;
};

export const isNativeSelectPopupOpen = (target: EventTarget | null): boolean =>
  target instanceof HTMLSelectElement && target.matches(":open");
