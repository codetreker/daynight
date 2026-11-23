export type SelectionControlDensity = 'compact' | 'filter' | 'form';
export type SelectionControlTouchMode = 'none' | 'responsive' | 'responsive-target' | 'container';
export type SelectionControlFocusTone = 'default' | 'task';
export type SelectionControlTextSize = 'sm' | 'xs';

export type SelectionControlPresentation = {
  readonly density?: SelectionControlDensity;
  readonly touchMode?: SelectionControlTouchMode;
  readonly focusTone?: SelectionControlFocusTone;
  readonly textSize?: SelectionControlTextSize;
  readonly pending?: boolean;
};
