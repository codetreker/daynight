import { memo } from 'react';
import { MarkdownView } from './MarkdownView';
import type { MarkdownImageNode, MarkdownImagePresentation, MarkdownSourceRange } from './types';
import type { ReactNode } from 'react';

export const ChatMarkdown = memo(function ChatMarkdown({ text, className = '', resourceUnavailable, tableLabel, imagePositions, renderImage, onInvalidImages }: {
  readonly text: string; readonly className?: string; readonly resourceUnavailable: string; readonly tableLabel: string;
  readonly imagePositions?: readonly MarkdownSourceRange[];
  readonly renderImage?: (node: MarkdownImageNode, presentation: MarkdownImagePresentation) => ReactNode;
  readonly onInvalidImages?: () => void;
}) {
  return <MarkdownView text={text} className={className} labels={{ resourceUnavailable, table: tableLabel }}
    resources={{ kind: 'chat', images: imagePositions && renderImage && onInvalidImages
      ? { kind: 'controlled', positions: imagePositions, render: renderImage, onInvalid: onInvalidImages }
      : { kind: 'unavailable' } }} />;
});
