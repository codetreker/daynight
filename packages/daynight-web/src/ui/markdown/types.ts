import type { MouseEvent, ReactNode } from 'react';

export type MarkdownDocumentImage = {
  readonly sourceUrl: string;
  readonly url: string;
  readonly alt: string;
  readonly title: string | undefined;
};

export type MarkdownResources = {
  readonly kind: 'document';
  readonly paused: boolean;
  readonly resolveUrl: (sourceUrl: string) => string | null;
  readonly onLinkClick?: (sourceUrl: string, event: MouseEvent<HTMLAnchorElement>) => void;
  readonly renderImage: (image: MarkdownDocumentImage) => ReactNode;
};

export type MarkdownLabels = {
  readonly resourceUnavailable: string;
  readonly table: string;
};

export type MarkdownViewProps = {
  readonly text: string;
  readonly resources: MarkdownResources;
  readonly className?: string;
  readonly labels?: MarkdownLabels;
};
