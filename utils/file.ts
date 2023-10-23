import * as fs from 'fs';
import { PathOrFileDescriptor, WriteFileOptions } from 'fs';

class SyncFileDebouncer {
  private static instance: SyncFileDebouncer;
  private readonly debounceTime: number;
  private timers: { [path: string]: NodeJS.Timeout } = {};

  private constructor(debounceTime: number = 300) {
    this.debounceTime = debounceTime;
  }

  public static getInstance(debounceTime?: number): SyncFileDebouncer {
    if (!SyncFileDebouncer.instance) {
      SyncFileDebouncer.instance = new SyncFileDebouncer(debounceTime);
    }
    return SyncFileDebouncer.instance;
  }

  public writeFileSync(
    file: string,
    data: string | NodeJS.ArrayBufferView,
    options?: WriteFileOptions,
  ) {
    if (this.timers[file]) {
      clearTimeout(this.timers[file]);
    }

    this.timers[file] = setTimeout(() => {
      fs.writeFileSync(file, data);
      delete this.timers[file];
    }, this.debounceTime);
  }
}

// 使用示例
export const fileDebouncer = SyncFileDebouncer.getInstance(500); // 100ms 的 debounce 时间

export function getImageContentType(ext: string): string {
  const normalizedExt = ext.startsWith('.')
    ? ext.slice(1).toLowerCase()
    : ext.toLowerCase();

  switch (normalizedExt) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'webp':
      return 'image/webp';
    // Add other cases as needed
    default:
      throw new Error(`Unsupported file extension: ${normalizedExt}`);
  }
}

export function getImageExtension(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpeg';
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    case 'image/webp':
      return 'webp';
    // Add other cases as needed
    default:
      throw new Error(`Unsupported content type: ${contentType}`);
  }
}
