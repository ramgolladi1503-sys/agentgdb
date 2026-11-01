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
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new TypeError('Path must be a non-empty string');
    }
    if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
      throw new Error(`VFS paths must be relative: ${relativePath}`);
    }
    // Reject traversal components before path.resolve can normalize them away.
    // In particular, `symlink/../file` may resolve outside the root at the OS
    // level even though lexical path normalization appears to put it back inside.
    if (relativePath.split(/[\\/]+/).includes('..')) {
      throw new Error(`Path traversal is not allowed: ${relativePath}`);
    }
    const root = fs.realpathSync(this.realRoot);
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path escapes VFS root: ${relativePath}`);
    }
    // Reject symlinked existing ancestors so a path cannot escape after resolution.
    let ancestor = resolved;
    while (ancestor !== root && !fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const realAncestor = fs.realpathSync(ancestor);
    const ancestorRelative = path.relative(root, realAncestor);
    if (ancestorRelative === '..' || ancestorRelative.startsWith(`..${path.sep}`) || path.isAbsolute(ancestorRelative)) {
      throw new Error(`Path traverses a symlink outside VFS root: ${relativePath}`);
    }
    return resolved;
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
    // Validate every target before the first mutation. Stage replacements alongside
    // their targets, then rename into place. This avoids partial writes on ordinary
    // validation/write failures; multi-file atomicity is not provided by filesystems.
    const writes = [...this.virtualFiles.entries()].map(([relPath, item]) => ({ relPath, item, target: this.resolve(relPath) }));
    const deletes = [...this.deletedFiles].map((relPath) => ({ relPath, target: this.resolve(relPath) }));
    const staged = [];
    try {
      for (const write of writes) {
        fs.mkdirSync(path.dirname(write.target), { recursive: true });
        const temp = path.join(path.dirname(write.target), `.agentgdb-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
        fs.writeFileSync(temp, write.item.content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
        staged.push({ ...write, temp });
      }
      for (const write of staged) fs.renameSync(write.temp, write.target);
      for (const deletion of deletes) if (fs.existsSync(deletion.target)) fs.unlinkSync(deletion.target);
    } catch (error) {
      for (const item of staged) if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp);
      throw error;
    }
    const committed = [...writes.map((write) => write.relPath), ...deletes.map((item) => item.relPath)];
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
