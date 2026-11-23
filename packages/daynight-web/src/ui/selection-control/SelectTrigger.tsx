import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { SelectionControlPresentation } from './presentation';
import { SelectionArrow } from './SelectionArrow';
import './selection-control.css';

type Presentation = SelectionControlPresentation & {
  readonly children: ReactNode;
  readonly count?: number;
  readonly layoutClassName?: string;
};
type ButtonProps = Omit<ComponentPropsWithRef<'button'>, 'className' | 'style' | 'children'> & Presentation & { readonly as?: 'button' };
type SummaryProps = Omit<ComponentPropsWithRef<'summary'>, 'className' | 'style' | 'children'> & Presentation & { readonly as: 'summary' };
export type SelectTriggerProps = ButtonProps | SummaryProps;

export const SelectTrigger = (props: SelectTriggerProps) => {
  const { density = 'form', touchMode = 'none', focusTone = 'default', textSize = 'sm', pending = false, layoutClassName, count, children, ...element } = props;
  const presentation = {
    className: layoutClassName === undefined ? 'selection-control select-trigger' : `selection-control select-trigger ${layoutClassName}`,
    'data-density': density,
    'data-touch-mode': touchMode,
    'data-focus-tone': focusTone,
    'data-text-size': textSize,
    'data-pending': pending,
  };
  const content = <><span className="select-trigger__label">{children}</span>{count !== undefined && count > 0 && <>{' '}<span className="select-trigger__count">{count}</span></>}<SelectionArrow className="select-trigger__arrow" /></>;
  if (element.as === 'summary') {
    const { as, ...summary } = element;
    return <summary {...summary} {...presentation}>{content}</summary>;
  }
  const { as, type = 'button', ...button } = element;
  return <button {...button} {...presentation} type={type}>{content}</button>;
};
