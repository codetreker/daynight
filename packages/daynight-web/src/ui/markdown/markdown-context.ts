import { createContext } from 'react';
import type { ImageValidation } from './markdown-plugins';
import type { MarkdownResources } from './types';

export type MarkdownContext = {
  readonly prefix: string;
  readonly references: WeakMap<object, string>;
  readonly resources: MarkdownResources;
  readonly validation: ImageValidation;
  readonly resourceUnavailable: string;
  readonly tableLabel: string;
  readonly codeLabel: string;
};
export const Context = createContext<MarkdownContext>(null!);
export const LinkedImage = createContext(false);
