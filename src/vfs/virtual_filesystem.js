import fs from 'fs';
import path from 'path';

/**
 * Task 2: Virtual In-Memory Filesystem (VFS)
 * Intercepts and tests agent file operations in a virtual sandbox
 * before allowing writes to hit the real disk.
 */
export class VirtualOverlayFilesystem {
  constructor(realRoot = process.cwd()) {
    this.realRoot = realRoot;
    this.virtualFiles = new Map(); // relativePath -> { content, mode, isNew }
    this.deletedFiles = new Set();
  }

  resolve(relativePath) {
    return path.resolve(this.realRoot, relativePath);
  }

  readFile(relativePath) {
    if (this.deletedFiles.has(relativePath)) {
      throw new Error(`ENOENT: file marked deleted in VFS: ${relativePath}`);
    }
    if (this.virtualFiles.has(relativePath)) {
      return this.virtualFiles.get(relativePath).content;
    }
    const realPath = this.resolve(relativePath);
    return fs.readFileSync(realPath, 'utf-8');
  }

  writeFile(relativePath, content) {
    this.deletedFiles.delete(relativePath);
    const existsReal = fs.existsSync(this.resolve(relativePath));
    this.virtualFiles.set(relativePath, {
      content,
      isNew: !existsReal,
      timestamp: Date.now()
    });
  }

  unlink(relativePath) {
    this.virtualFiles.delete(relativePath);
    this.deletedFiles.add(relativePath);
  }

  getPendingDiffs() {
    const diffs = [];
    for (const [relPath, item] of this.virtualFiles.entries()) {
      diffs.push({
        path: relPath,
        status: item.isNew ? 'CREATED' : 'MODIFIED',
        size: item.content.length,
        timestamp: item.timestamp
      });
    }
    for (const relPath of this.deletedFiles) {
      diffs.push({ path: relPath, status: 'DELETED' });
    }
    return diffs;
  }

  commitToRealDisk() {
    const committed = [];
    for (const [relPath, item] of this.virtualFiles.entries()) {
      const realPath = this.resolve(relPath);
      fs.mkdirSync(path.dirname(realPath), { recursive: true });
      fs.writeFileSync(realPath, item.content, 'utf-8');
      committed.push(relPath);
    }
    for (const relPath of this.deletedFiles) {
      const realPath = this.resolve(relPath);
      if (fs.existsSync(realPath)) fs.unlinkSync(realPath);
      committed.push(relPath);
    }
    this.virtualFiles.clear();
    this.deletedFiles.clear();
    return committed;
  }

  rollback() {
    const count = this.virtualFiles.size + this.deletedFiles.size;
    this.virtualFiles.clear();
    this.deletedFiles.clear();
    return count;
  }
}
