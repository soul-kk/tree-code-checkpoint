import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const CHECKPOINT_ENTRY_TYPE = "tree-code-checkpoint";
export const CHECKPOINT_VERSION = 1;
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface FileState {
  exists: boolean;
  hash?: string;
  blob?: string;
  mode?: number;
  size?: number;
}

export type Manifest = Record<string, FileState>;

export interface MutationData {
  version: 1;
  kind: "mutation";
  path: string;
  before: FileState;
  after: FileState;
  toolCallId: string;
  toolName: "edit" | "write";
}

export interface AnchorData {
  version: 1;
  kind: "anchor";
  manifest: Manifest;
  reason: "keep" | "restore";
}

export type CheckpointData = MutationData | AnchorData;

export interface SessionEntryLike {
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string };
}

export interface RestoreResult {
  changedPaths: string[];
}

export interface RestorePlan {
  expected: Manifest;
  desired: Manifest;
  changedPaths: string[];
}

function cloneState(state: FileState): FileState {
  return { ...state };
}

export function cloneManifest(manifest: Manifest): Manifest {
  return Object.fromEntries(Object.entries(manifest).map(([path, state]) => [path, cloneState(state)]));
}

export function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function statesEqual(left: FileState | undefined, right: FileState | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.hash === right.hash && left.mode === right.mode;
}

export function manifestsEqual(left: Manifest, right: Manifest): boolean {
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const path of paths) {
    if (!statesEqual(left[path], right[path])) return false;
  }
  return true;
}

export function normalizeProjectPath(root: string, inputPath: string): { absolutePath: string; relativePath: string } {
  const stripped = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const absolutePath = resolve(root, stripped);
  const relativePath = relative(resolve(root), absolutePath);
  if (!relativePath || relativePath === ".") {
    throw new Error("The project root is not a writable file target.");
  }
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Checkpointing refuses paths outside the project: ${inputPath}`);
  }
  return { absolutePath, relativePath: relativePath.split(sep).join("/") };
}

function checkpointData(entry: SessionEntryLike): CheckpointData | undefined {
  if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) return undefined;
  const data = entry.data as Partial<CheckpointData> | undefined;
  if (!data || data.version !== CHECKPOINT_VERSION) return undefined;
  if (data.kind !== "mutation" && data.kind !== "anchor") return undefined;
  return data as CheckpointData;
}

export function branchTo(entries: SessionEntryLike[], leafId: string | null): SessionEntryLike[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const reverse: SessionEntryLike[] = [];
  const seen = new Set<string>();
  let id: string | null = leafId;
  while (id !== null) {
    if (seen.has(id)) throw new Error(`Cycle in session tree at ${id}`);
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`Missing session entry ${id}`);
    reverse.push(entry);
    id = entry.parentId;
  }
  return reverse.reverse();
}

/**
 * Reconstructs the workspace represented by a session node.
 * The first recorded pre-image of each path is its root baseline. Mutation and
 * anchor entries on the selected branch then override that baseline.
 */
export function manifestAt(entries: SessionEntryLike[], leafId: string | null): Manifest {
  const manifest: Manifest = {};

  // Origins are intentionally global to the session tree: the earliest mutation
  // is the only observation available for nodes predating that file's tracking.
  for (const entry of entries) {
    const data = checkpointData(entry);
    if (data?.kind === "mutation" && manifest[data.path] === undefined) {
      manifest[data.path] = cloneState(data.before);
    }
  }

  for (const entry of branchTo(entries, leafId)) {
    const data = checkpointData(entry);
    if (!data) continue;
    if (data.kind === "mutation") {
      manifest[data.path] = cloneState(data.after);
    } else {
      for (const [path, state] of Object.entries(data.manifest)) {
        manifest[path] = cloneState(state);
      }
    }
  }
  return manifest;
}

export function effectiveTreeLeaf(entry: SessionEntryLike): string | null {
  if (
    (entry.type === "message" && entry.message?.role === "user") ||
    entry.type === "custom_message"
  ) {
    return entry.parentId;
  }
  return entry.id;
}

export function changedManifestPaths(current: Manifest, desired: Manifest): string[] {
  return [...new Set([...Object.keys(current), ...Object.keys(desired)])]
    .filter((path) => !statesEqual(current[path], desired[path]))
    .sort();
}

export class BlobStore {
  readonly root: string;
  readonly objectsDir: string;
  readonly maxFileBytes: number;

  constructor(root: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
    this.root = resolve(root);
    this.objectsDir = resolve(this.root, "objects");
    this.maxFileBytes = maxFileBytes;
  }

  async initialize(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    await chmod(this.objectsDir, 0o700).catch(() => undefined);
  }

  async put(content: Uint8Array): Promise<string> {
    if (content.byteLength > this.maxFileBytes) {
      throw new Error(
        `File is ${content.byteLength} bytes; checkpoint limit is ${this.maxFileBytes} bytes.`,
      );
    }
    await this.initialize();
    const hash = hashBytes(content);
    const target = resolve(this.objectsDir, hash);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await rename(temp, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    return hash;
  }

  async get(blob: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(blob)) throw new Error(`Invalid checkpoint blob id: ${blob}`);
    const content = await readFile(resolve(this.objectsDir, blob));
    if (hashBytes(content) !== blob) throw new Error(`Checkpoint blob failed integrity check: ${blob}`);
    return content;
  }

  async has(blob: string): Promise<boolean> {
    try {
      await this.get(blob);
      return true;
    } catch {
      return false;
    }
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/").filter(Boolean);
  let current = resolve(root);
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${relativePath}`);
      if (current !== resolve(root, relativePath) && !stat.isDirectory()) {
        throw new Error(`A parent component is not a directory: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readPathState(
  root: string,
  relativePath: string,
  maxFileBytes: number,
): Promise<{ state: FileState; content?: Buffer }> {
  const normalized = normalizeProjectPath(root, relativePath);
  await assertNoSymlinkComponents(root, normalized.relativePath);
  try {
    const beforeStat = await lstat(normalized.absolutePath);
    if (beforeStat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${relativePath}`);
    if (!beforeStat.isFile()) throw new Error(`Only regular files are supported: ${relativePath}`);
    if (beforeStat.size > maxFileBytes) {
      throw new Error(`File is ${beforeStat.size} bytes; checkpoint limit is ${maxFileBytes} bytes.`);
    }
    const content = await readFile(normalized.absolutePath);
    const afterStat = await lstat(normalized.absolutePath);
    if (
      beforeStat.dev !== afterStat.dev ||
      beforeStat.ino !== afterStat.ino ||
      beforeStat.size !== afterStat.size ||
      beforeStat.mtimeMs !== afterStat.mtimeMs
    ) {
      throw new Error(`File changed while checkpointing: ${relativePath}`);
    }
    return {
      state: {
        exists: true,
        hash: hashBytes(content),
        mode: afterStat.mode & 0o777,
        size: content.byteLength,
      },
      content,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: { exists: false } };
    throw error;
  }
}

/** Inspect a path without mutating the checkpoint object store. */
export async function inspectPathState(
  root: string,
  relativePath: string,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<FileState> {
  return (await readPathState(root, relativePath, maxFileBytes)).state;
}

export async function snapshotPath(root: string, relativePath: string, store: BlobStore): Promise<FileState> {
  const { state, content } = await readPathState(root, relativePath, store.maxFileBytes);
  if (!state.exists || !content) return state;
  const blob = await store.put(content);
  return { ...state, blob };
}

/**
 * Prepares the complete post-image before touching the target, then atomically
 * replaces it. onCommit runs synchronously immediately after rename succeeds,
 * so callers always have a rollback image before any later await can fail.
 */
export async function writeTrackedContent(
  root: string,
  relativePath: string,
  content: Uint8Array,
  before: FileState,
  store: BlobStore,
  onCommit: (after: FileState) => void,
): Promise<FileState> {
  if (content.byteLength > store.maxFileBytes) {
    throw new Error(`File is ${content.byteLength} bytes; checkpoint limit is ${store.maxFileBytes} bytes.`);
  }
  const { absolutePath } = normalizeProjectPath(root, relativePath);
  await assertNoSymlinkComponents(root, relativePath);

  // Persist the post-image first. If this fails, the project file is untouched.
  const blob = await store.put(content);
  const mode = before.exists ? (before.mode ?? 0o600) : (0o666 & ~process.umask());
  const after: FileState = {
    exists: true,
    hash: hashBytes(content),
    blob,
    mode,
    size: content.byteLength,
  };

  await mkdir(dirname(absolutePath), { recursive: true });
  await assertNoSymlinkComponents(root, relativePath);
  const temp = resolve(dirname(absolutePath), `.${randomUUID()}.tree-checkpoint-write.tmp`);
  try {
    await writeFile(temp, content, { mode, flag: "wx" });
    await chmod(temp, mode);

    // Close the capture/write race before the atomic commit.
    const latest = await inspectPathState(root, relativePath, store.maxFileBytes);
    if (!statesEqual(latest, before)) {
      throw new Error(`Conflict: ${relativePath} changed while preparing the tracked write.`);
    }

    await rename(temp, absolutePath);
    onCommit(after);

    // Verification does not write a new object, so an object-store write failure
    // can no longer occur after the project file has changed.
    const actual = await inspectPathState(root, relativePath, store.maxFileBytes);
    if (!statesEqual(actual, after)) {
      throw new Error(`Post-write verification failed for ${relativePath}`);
    }
    return after;
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function verifyManifest(
  root: string,
  expected: Manifest,
  paths: Iterable<string>,
  store: BlobStore,
): Promise<void> {
  for (const path of paths) {
    const expectedState = expected[path];
    if (!expectedState) throw new Error(`No expected checkpoint state for ${path}`);
    const actual = await snapshotPath(root, path, store);
    if (!statesEqual(actual, expectedState)) {
      throw new Error(
        `Conflict: ${path} changed outside the checkpointed edit/write history ` +
          `(expected ${describeState(expectedState)}, found ${describeState(actual)}).`,
      );
    }
  }
}

function describeState(state: FileState): string {
  if (!state.exists) return "absent";
  return `${state.hash?.slice(0, 12) ?? "unknown hash"}, mode ${state.mode?.toString(8)}`;
}

async function assertRestoreWritable(root: string, relativePath: string, current: FileState): Promise<void> {
  const { absolutePath } = normalizeProjectPath(root, relativePath);
  await assertNoSymlinkComponents(root, relativePath);
  if (current.exists) {
    await access(absolutePath, fsConstants.R_OK | fsConstants.W_OK).catch((error) => {
      throw new Error(`File is not readable and writable: ${relativePath}: ${String(error)}`);
    });
  }

  // Atomic replacement and deletion require write/search permission on the
  // nearest existing parent directory. Missing descendants are created later.
  let parent = dirname(absolutePath);
  const rootPath = resolve(root);
  while (true) {
    try {
      const stat = await lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Restore parent is not a regular directory: ${relativePath}`);
      }
      await access(parent, fsConstants.W_OK | fsConstants.X_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Restore destination is not writable: ${relativePath}: ${String(error)}`);
      }
      if (parent === rootPath) throw error;
      const next = dirname(parent);
      if (next === parent || relative(rootPath, next).startsWith("..")) throw error;
      parent = next;
    }
  }
}

async function writeState(root: string, relativePath: string, state: FileState, store: BlobStore): Promise<void> {
  const { absolutePath } = normalizeProjectPath(root, relativePath);
  await assertNoSymlinkComponents(root, relativePath);
  if (!state.exists) {
    try {
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Refusing to delete non-regular path: ${relativePath}`);
      }
      await unlink(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  if (!state.blob || !state.hash) throw new Error(`Checkpoint content is missing for ${relativePath}`);
  const content = await store.get(state.blob);
  if (hashBytes(content) !== state.hash) throw new Error(`Checkpoint hash mismatch for ${relativePath}`);
  await mkdir(dirname(absolutePath), { recursive: true });
  await assertNoSymlinkComponents(root, relativePath);
  const temp = resolve(dirname(absolutePath), `.${randomUUID()}.tree-checkpoint.tmp`);
  try {
    await writeFile(temp, content, { mode: state.mode ?? 0o600, flag: "wx" });
    await chmod(temp, state.mode ?? 0o600);
    await rename(temp, absolutePath);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function buildRestorePlan(
  root: string,
  expected: Manifest,
  desired: Manifest,
  store: BlobStore,
): Promise<RestorePlan> {
  const changedPaths = changedManifestPaths(expected, desired);
  await verifyManifest(root, expected, changedPaths, store);
  for (const path of changedPaths) {
    const current = expected[path];
    const target = desired[path];
    if (!current) throw new Error(`Current checkpoint has no state for ${path}`);
    if (!target) throw new Error(`Target checkpoint has no state for ${path}`);
    await assertRestoreWritable(root, path, current);
    if (target.exists && (!target.blob || !(await store.has(target.blob)))) {
      throw new Error(`Checkpoint data is missing or corrupt for ${path}`);
    }
  }
  return { expected: cloneManifest(expected), desired: cloneManifest(desired), changedPaths };
}

export async function applyRestorePlan(
  root: string,
  plan: RestorePlan,
  store: BlobStore,
): Promise<RestoreResult> {
  // Revalidate immediately before commit to close the dialog/navigation race.
  await verifyManifest(root, plan.expected, plan.changedPaths, store);
  const rollback: Manifest = {};
  for (const path of plan.changedPaths) rollback[path] = await snapshotPath(root, path, store);

  const applied: string[] = [];
  try {
    for (const path of plan.changedPaths) {
      await writeState(root, path, plan.desired[path], store);
      // Mark the path before verification: a successful write followed by a
      // verification failure must still participate in rollback.
      applied.push(path);
      const actual = await snapshotPath(root, path, store);
      if (!statesEqual(actual, plan.desired[path])) {
        throw new Error(`Post-write verification failed for ${path}`);
      }
    }
    return { changedPaths: [...applied] };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const path of [...applied].reverse()) {
      try {
        await writeState(root, path, rollback[path], store);
      } catch (rollbackError) {
        rollbackErrors.push(`${path}: ${String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${String(error)}; rollback also failed: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
}

export async function restoreSingleMutation(
  root: string,
  from: FileState,
  to: FileState,
  relativePath: string,
  store: BlobStore,
): Promise<void> {
  // This rollback path deliberately avoids snapshotPath(): a failed object-store
  // write after the project-file commit must not prevent restoration from an
  // already-persisted pre-image.
  const actual = await inspectPathState(root, relativePath, store.maxFileBytes);
  if (!statesEqual(actual, from)) {
    throw new Error(
      `Conflict: cannot roll back ${relativePath}; current content no longer matches the committed post-image.`,
    );
  }
  await writeState(root, relativePath, to, store);
  const restored = await inspectPathState(root, relativePath, store.maxFileBytes);
  if (!statesEqual(restored, to)) throw new Error(`Rollback verification failed for ${relativePath}`);
}
