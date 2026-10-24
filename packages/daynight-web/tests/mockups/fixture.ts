import type { Attachment } from '../../src/api/types';
import { ApiError, attachmentContentType } from '../../src/api/client';
import type { AttachmentUrls } from '../../src/features/task-detail/attachments/TaskAttachments';
import type { AttachmentApi } from '../../src/features/task-detail/attachments/useAttachments';
import guide from './files/docs/guide.md?raw';
import flowcharts from './files/docs/flowcharts.md?raw';
import json from './files/data/example.json?raw';
import style from './files/site/style.css?raw';
import script from './files/site/app.js?raw';
import tallMarkdown from './files/docs/tall.md?raw';
import tallText from './files/data/tall.txt?raw';
import { longConfirmationPath } from './attachment-paths';

export type MockupScenario = 'files' | 'empty' | 'upload-error' | 'loading' | 'list-error' | 'preview-error' | 'busy' | 'delete-error' | 'delete-pending';
export const mockupLongPath = `docs/${'long-file-name-'.repeat(12)}.txt`;
const timestamp = '2026-10-21T10:00:00Z';
const sources = [
  ['docs/guide.md', 'text/markdown', guide],
  ['docs/flowcharts.md', 'text/markdown', flowcharts],
  ['examples/guide.md', 'text/markdown', guide],
  ['images/workflow.svg', 'image/svg+xml', ''],
  ['site/index.html', 'text/html', ''],
  ['site/style.css', 'text/css', style],
  ['site/app.js', 'text/javascript', script],
  ['data/example.json', 'application/json', json],
  ['brief.pdf', 'application/pdf', ''],
  ['docs/tall.md', 'text/markdown', tallMarkdown],
  ['data/tall.txt', 'text/plain', tallText],
  ['images/tall.svg', 'image/svg+xml', ''],
  ['site/tall.html', 'text/html', ''],
  ['tall.pdf', 'application/pdf', ''],
  [mockupLongPath, 'text/plain', tallText],
  [longConfirmationPath, 'text/plain', tallText],
  ['archive.bin', 'application/octet-stream', 'Binary attachment'],
] as const;

type FixtureFile = { readonly attachment: Attachment; readonly text: string };
const readFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener('load', () => resolve(String(reader.result)));
  reader.addEventListener('error', () => reject(reader.error));
  reader.readAsText(file);
});

export const createAttachmentFixture = (scenario: MockupScenario, location: {
  readonly files: string;
  readonly page: string;
} = { files: '/tests/mockups/files/', page: '/tests/mockups/attachments.html' }) => {
  const base = location.files;
  const files = new Map<string, FixtureFile>(scenario === 'empty' ? [] : sources.map(([path, contentType, text]) => [path, {
    attachment: { path, contentType, sizeBytes: text === '' ? 640 : new TextEncoder().encode(text).length, createdAt: timestamp, updatedAt: timestamp },
    text,
  }]));
  const pathUrls = new Map([...files.keys()].map((path) => [path, `${base}${path === mockupLongPath || path === longConfirmationPath ? 'data/tall.txt' : path === 'examples/guide.md' ? 'docs/guide.md' : path}`]));
  const ownedUrls = new Set<string>();
  let revision = 0;
  let deleteAttempts = 0;
  const required = (path: string) => {
    const file = files.get(path);
    if (file === undefined) throw new Error('Fixture attachment does not exist.');
    return file;
  };
  const api: AttachmentApi = {
    list: async () => {
      if (scenario === 'loading') return new Promise(() => {});
      if (scenario === 'list-error') throw new Error('Mockup list failed.');
      return { items: [...files.values()].map((file) => file.attachment), nextCursor: null };
    },
    readText: async (_project, _task, path) => {
      if (scenario === 'preview-error') throw new Error('Mockup preview failed.');
      return required(path).text;
    },
    checkPreview: async (_project, _task, path) => {
      if (scenario === 'preview-error') throw new Error('Mockup preview failed.');
      required(path);
    },
    put: async (_project, _task, path, file) => {
      if (scenario === 'busy') return new Promise(() => {});
      if (scenario === 'upload-error') throw new Error('Mockup upload failed.');
      const previous = files.get(path);
      const url = URL.createObjectURL(file);
      ownedUrls.add(url);
      const attachment: Attachment = { path, contentType: attachmentContentType(path), sizeBytes: file.size, createdAt: previous === undefined ? new Date().toISOString() : previous.attachment.createdAt, updatedAt: new Date(Date.now() + ++revision).toISOString() };
      files.set(path, { attachment, text: await readFile(file) });
      pathUrls.set(path, url);
      return attachment;
    },
    remove: async (_project, _task, path, signal) => {
      required(path);
      if (scenario === 'delete-error' && ++deleteAttempts === 1) throw new ApiError('server', 503, 'unavailable', 'mockup-delete-1');
      if (scenario === 'delete-pending') return new Promise((_resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      files.delete(path);
    },
  };
  const fileUrl = (path: string): string => {
    const url = pathUrls.get(path);
    if (url === undefined) throw new Error('Fixture attachment URL was never allocated.');
    return url;
  };
  const urls: AttachmentUrls = { page: (path) => `${location.page}?file=${encodeURIComponent(path)}&scenario=${scenario}`, previewRoot: base, preview: fileUrl, download: (path) => pathUrls.get(path) ?? `${base}${path.split('/').map(encodeURIComponent).join('/')}` };
  return { api, urls, dispose: () => { ownedUrls.forEach((url) => URL.revokeObjectURL(url)); } };
};
