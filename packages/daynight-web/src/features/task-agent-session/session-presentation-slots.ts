import type { ReactNode, RefObject } from 'react';
import type { SessionSnapshot } from '../../api/types';
import type { SessionDraft, SessionViewState } from './client';
import type { SessionDisplayMode } from './display-mode';

export type SessionPresentationVariant = 'default' | 'assistant';

/** Render each supplied control once, inside the shared Session section. */
export type SessionHeaderSlot = {
  readonly snapshot: SessionSnapshot | null;
  readonly startupReport: SessionViewState['startupReport'];
  readonly active: boolean;
  readonly current: boolean;
  readonly available: boolean;
  readonly readOnly: boolean;
  readonly runtimeReady: boolean;
  readonly authPaused: boolean;
  readonly status: SessionViewState['status'];
  readonly fullscreen: boolean;
  readonly displayMode: SessionDisplayMode;
  readonly statusDescriptionId: string;
  readonly provider: ReactNode;
  readonly activity: ReactNode;
  readonly display: ReactNode;
  readonly focus: ReactNode;
  readonly refresh: ReactNode;
};

export type SessionEmptySlot = {
  readonly draft: SessionDraft;
  /** Changes only this admitted execution's draft, then focuses its input. Never submits. */
  readonly setDraftAndFocus: (text: string) => void;
};

export type SessionComposerInputSlot = {
  readonly snapshot: SessionSnapshot | null;
  readonly active: boolean;
  readonly connected: boolean;
  readonly authPaused: boolean;
  /** Preserve this textarea, its ref, handlers and accessibility attributes. */
  readonly input: ReactNode;
  readonly text: string;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly setText: (text: string) => void;
};

export type SessionComposerFooterSlot = {
  readonly settings: ReactNode;
  /** Includes the existing activity label and independently gated Interrupt control. */
  readonly activity: ReactNode;
  readonly submit: ReactNode;
};

/** Keep the chosen DOM structure stable for a mounted Composer. Do not omit controls. */
export type SessionComposerPresentation = {
  readonly renderInput?: (slot: SessionComposerInputSlot) => ReactNode;
  readonly renderFooter?: (slot: SessionComposerFooterSlot) => ReactNode;
};

/** Optional presentation only; SessionView retains state, admission and error ownership. */
export type SessionPresentationSlots = {
  readonly variant?: SessionPresentationVariant;
  readonly renderHeader?: (slot: SessionHeaderSlot) => ReactNode;
  /** Called only for confirmed empty live history. Keep this slot configured across updates. */
  readonly renderEmpty?: (slot: SessionEmptySlot) => ReactNode;
  readonly composer?: SessionComposerPresentation;
};
