import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';

// Durable host store behind the Worker's session storage (src/runtime/blob-storage.js).
// `read` returns the text or null; `write` resolves only after the new content is on
// disk and has replaced the old one atomically: temp file, fsync, rename.
// Writes to the same name are serialized. Files live in `<directory>/<name>.json`.
const NAME = /^[a-z0-9-]{1,80}$/;
const WRITE_CHARS = 300000;
const NOT_FOUND = 13900002;

export class DshFileStore {
  private directory: string;
  private pending: Map<string, Promise<void>> = new Map();

  // `directory` must be app-private, e.g. context.filesDir + '/dsh'.
  constructor(directory: string) {
    this.directory = directory;
    if (!fileIo.accessSync(directory)) fileIo.mkdirSync(directory, true);
  }

  private path(name: string): string {
    if (!NAME.test(name)) throw new Error('invalid_store_name');
    return this.directory + '/' + name + '.json';
  }

  async read(name: string): Promise<string | null> {
    const path = this.path(name);
    await this.pending.get(name)?.catch((): void => {});
    try { return await fileIo.readText(path); }
    catch (error) {
      if ((error as BusinessError).code === NOT_FOUND) return null;
      throw error as Error;
    }
  }

  write(name: string, text: string): Promise<void> {
    const path = this.path(name);
    const previous = this.pending.get(name) || Promise.resolve();
    const task = previous.catch((): void => {}).then((): Promise<void> => this.replace(path, text));
    this.pending.set(name, task);
    const release = (): void => { if (this.pending.get(name) === task) this.pending.delete(name); };
    task.then(release, release);
    return task;
  }

  private async replace(path: string, text: string): Promise<void> {
    const temporary = path + '.' + util.generateRandomUUID() + '.tmp';
    const encoder = new util.TextEncoder();
    let file: fileIo.File | undefined = undefined;
    try {
      file = await fileIo.open(temporary, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY);
      let offset = 0;
      // Encode in bounded pieces so a large record is not duplicated in memory at once;
      // never split a surrogate pair between pieces.
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + WRITE_CHARS, text.length);
        if (end < text.length) {
          const last = text.charCodeAt(end - 1);
          if (last >= 0xD800 && last <= 0xDBFF) end--;
        }
        const bytes = encoder.encodeInto(text.substring(start, end));
        for (let written = 0; written < bytes.byteLength;) {
          const count = await fileIo.write(file.fd, bytes.buffer.slice(bytes.byteOffset + written, bytes.byteOffset + bytes.byteLength), { offset: offset });
          if (count <= 0) throw new Error('short_store_write');
          written += count;
          offset += count;
        }
        start = end;
      }
      await fileIo.fsync(file.fd);
      await fileIo.close(file);
      file = undefined;
      await fileIo.rename(temporary, path);
    } finally {
      if (file) { try { await fileIo.close(file); } catch (_) {} }
      // Cleanup cannot turn a successful rename into a reported failure.
      try { await fileIo.unlink(temporary); } catch (_) {}
    }
  }
}
