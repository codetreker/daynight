import { useI18n } from '../../../i18n/LocaleProvider';
import { ImageFailure } from './image-types';

const en = {
  preview: 'View image', loading: 'Loading image…', pending: 'Image is being saved', unavailable: 'Image unavailable',
  decodeFailed: 'This browser cannot display this image.', readFailed: 'The saved image could not be read.', retry: 'Retry',
  close: 'Close image preview', fit: 'Fit to window', original: 'Original size', download: 'Download', downloadImage: 'Download image',
  downloading: 'Preparing download…', downloadFailed: 'The image could not be downloaded.', stage: 'Image preview',
  cached: 'Image unavailable in the recent preview',
  corrupt: 'The saved image is damaged or no longer matches its description.', unsupported: 'This file is not a supported image.',
  readTimeout: 'Reading the image timed out. Try again.', cacheBusy: 'Image loading is busy. Open the image to view it.',
  downloadBusy: 'Downloads are busy. Try again shortly.', accessPending: 'Image access is being checked.', accessRevoked: 'Image access has ended.',
};
const zh: { readonly [K in keyof typeof en]: string } = {
  preview: '查看图片', loading: '正在加载图片…', pending: '图片正在保存', unavailable: '图片不可用',
  decodeFailed: '此浏览器无法显示这张图片。', readFailed: '无法读取已保存的图片。', retry: '重试',
  close: '关闭图片预览', fit: '适应窗口', original: '原始比例', download: '下载', downloadImage: '下载图片',
  downloading: '正在准备下载…', downloadFailed: '无法下载这张图片。', stage: '图片预览',
  cached: '近期预览中的图片不可用',
  corrupt: '已保存的图片损坏，或与其描述不一致。', unsupported: '此文件不是支持的图片格式。',
  readTimeout: '图片读取超时，请重试。', cacheBusy: '图片加载繁忙，可以打开图片查看。',
  downloadBusy: '下载繁忙，请稍后重试。', accessPending: '正在核对图片访问权。', accessRevoked: '图片访问权已失效。',
};
export const useImageMessages = () => useI18n().locale === 'zh-CN' ? zh : en;
export type ImageIssue = 'corrupt' | 'unsupported' | 'readTimeout' | 'cacheBusy' | 'downloadBusy' | 'accessPending' | 'accessRevoked' | 'decodeFailed' | 'readFailed' | 'downloadFailed';
export function imageIssue(error: unknown, fallback: ImageIssue): ImageIssue {
  if (!(error instanceof ImageFailure)) return fallback;
  switch (error.code) {
    case 'integrity_failed': case 'resource_changed': return 'corrupt';
    case 'unsupported_format': return 'unsupported';
    case 'read_timeout': return 'readTimeout';
    case 'cache_busy': return 'cacheBusy';
    case 'download_busy': return 'downloadBusy';
    case 'access_pending': return 'accessPending';
    case 'access_revoked': return 'accessRevoked';
    case 'decode_failed': case 'decode_timeout': return 'decodeFailed';
    default: return fallback;
  }
}
