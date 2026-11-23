import type { MouseEvent, ReactNode } from 'react';

export type MarkdownSourceRange = { readonly start: number; readonly end: number };
export type MarkdownImageNode = MarkdownSourceRange & { readonly alt: string };
export type MarkdownImagePresentation = 'standalone' | 'linked' | 'actions';
export type MarkdownDocumentImage = {
  readonly sourceUrl: string;
  readonly url: string;
  readonly alt: string;
  readonly title: string | undefined;
};
export type MarkdownChatImages =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'controlled'; readonly positions: readonly MarkdownSourceRange[];
      readonly render: (node: MarkdownImageNode, presentation: MarkdownImagePresentation) => ReactNode;
      readonly onInvalid: () => void };
export type MarkdownResources =
  | { readonly kind: 'document'; readonly paused: boolean;
      readonly resolveUrl: (sourceUrl: string) => string | null;
      readonly onLinkClick?: (sourceUrl: string, event: MouseEvent<HTMLAnchorElement>) => void;
      readonly renderImage: (image: MarkdownDocumentImage) => ReactNode }
  | { readonly kind: 'chat'; readonly images: MarkdownChatImages };
export type MarkdownLabels = { readonly resourceUnavailable: string; readonly table: string };
export type MarkdownViewProps = {
  readonly text: string;
  readonly resources: MarkdownResources;
  readonly className?: string;
  readonly labels?: MarkdownLabels;
};
