import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  applyRestorePlan,
  BlobStore,
  buildRestorePlan,
  CHECKPOINT_ENTRY_TYPE,
  CHECKPOINT_VERSION,
  cloneManifest,
  effectiveTreeLeaf,
  manifestAt,
  normalizeProjectPath,
  restoreSingleMutation,
  snapshotPath,
  statesEqual,
  writeTrackedContent,
} from "./checkpoint-core.ts";
import type {
  AnchorData,
  FileState,
  Manifest,
  MutationData,
  RestorePlan,
  SessionEntryLike,
} from "./checkpoint-core.ts";

interface MutationCapture {
  toolCallId: string;
  toolName: "edit" | "write";
  relativePath: string;
  before?: FileState;
  after?: FileState;
}

interface PendingNavigation {
  oldLeafId: string | null;
  mode: "keep" | "restore";
  plan?: RestorePlan;
  desired: Manifest;
}

const RESTORE = "恢复代码到目标节点";
const KEEP = "保留当前代码";
const CANCEL = "取消此次树导航";

function asEntries(ctx: ExtensionContext): SessionEntryLike[] {
  return ctx.sessionManager.getEntries() as SessionEntryLike[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTrackablePath(root: string, inputPath: string) {
  const normalized = normalizeProjectPath(root, inputPath);
  const checkpointPrefix = `${CONFIG_DIR_NAME}/tree-code-checkpoints`;
  if (
    normalized.relativePath === checkpointPrefix ||
    normalized.relativePath.startsWith(`${checkpointPrefix}/`)
  ) {
    throw new Error("The checkpoint object store is protected from edit/write tools.");
  }
  return normalized;
}

export default function treeCodeCheckpoint(pi: ExtensionAPI) {
  const captureStorage = new AsyncLocalStorage<MutationCapture>();
  let projectRoot = "";
  let store: BlobStore | undefined;
  let currentManifest: Manifest = {};
  let pendingNavigation: PendingNavigation | undefined;
  let toolsRegistered = false;

  function requireStore(): BlobStore {
    if (!store) throw new Error("Tree code checkpoint store is not initialized.");
    return store;
  }

  async function captureBefore(relativePath: string): Promise<FileState> {
    const checkpointStore = requireStore();
    const before = await snapshotPath(projectRoot, relativePath, checkpointStore);
    const expected = currentManifest[relativePath];
    if (expected && !statesEqual(before, expected)) {
      throw new Error(
        `Refusing to modify ${relativePath}: it changed outside Pi's checkpointed edit/write history. ` +
          "Keep the external change safe, then resolve it manually before retrying.",
      );
    }
    return before;
  }

  async function rollbackUnrecorded(capture: MutationCapture): Promise<void> {
    if (!capture.before || !capture.after || statesEqual(capture.before, capture.after)) return;
    await restoreSingleMutation(
      projectRoot,
      capture.after,
      capture.before,
      capture.relativePath,
      requireStore(),
    );
  }

  async function persistMutation(capture: MutationCapture): Promise<void> {
    if (!capture.before || !capture.after) {
      throw new Error(`Checkpoint capture was incomplete for ${capture.relativePath}`);
    }
    if (statesEqual(capture.before, capture.after)) return;
    const data: MutationData = {
      version: CHECKPOINT_VERSION,
      kind: "mutation",
      path: capture.relativePath,
      before: capture.before,
      after: capture.after,
      toolCallId: capture.toolCallId,
      toolName: capture.toolName,
    };
    try {
      pi.appendEntry(CHECKPOINT_ENTRY_TYPE, data);
      currentManifest[capture.relativePath] = { ...capture.after };
    } catch (error) {
      await rollbackUnrecorded(capture).catch((rollbackError) => {
        throw new Error(
          `Could not persist checkpoint (${errorText(error)}), and rollback failed: ${errorText(rollbackError)}`,
        );
      });
      // Prevent the outer execute() catch from attempting the same rollback twice.
      capture.after = capture.before;
      throw new Error(`Could not persist checkpoint; file change was rolled back: ${errorText(error)}`);
    }
  }

  function registerTrackedTools() {
    if (toolsRegistered) return;
    toolsRegistered = true;

    const editBase = createEditToolDefinition(projectRoot, {
      operations: {
        access: async (absolutePath) => {
          const capture = captureStorage.getStore();
          if (!capture) throw new Error("Missing edit checkpoint context.");
          const normalized = normalizeTrackablePath(projectRoot, absolutePath);
          if (normalized.relativePath !== capture.relativePath) throw new Error("Edit path changed unexpectedly.");
          await access(absolutePath, fsConstants.R_OK | fsConstants.W_OK);
        },
        readFile: async (_absolutePath) => {
          const capture = captureStorage.getStore();
          if (!capture) throw new Error("Missing edit checkpoint context.");
          capture.before = await captureBefore(capture.relativePath);
          if (!capture.before.exists || !capture.before.blob) {
            throw new Error(`Could not edit missing file: ${capture.relativePath}`);
          }
          return requireStore().get(capture.before.blob);
        },
        writeFile: async (_absolutePath, content) => {
          const capture = captureStorage.getStore();
          if (!capture || !capture.before) throw new Error("Missing edit pre-image.");
          await writeTrackedContent(
            projectRoot,
            capture.relativePath,
            Buffer.from(content, "utf8"),
            capture.before,
            requireStore(),
            (after) => { capture.after = after; },
          );
        },
      },
    });

    pi.registerTool({
      ...editBase,
      executionMode: "sequential",
      async execute(toolCallId, input, signal, onUpdate, ctx) {
        const { relativePath } = normalizeTrackablePath(projectRoot, input.path);
        // This performs the path/symlink validation before the built-in implementation writes.
        await snapshotPath(projectRoot, relativePath, requireStore());
        const capture: MutationCapture = { toolCallId, toolName: "edit", relativePath };
        try {
          const result = await captureStorage.run(capture, () =>
            editBase.execute(toolCallId, input, signal, onUpdate, ctx),
          );
          await persistMutation(capture);
          return result;
        } catch (error) {
          if (capture.after) await rollbackUnrecorded(capture);
          throw error;
        }
      },
    });

    const writeBase = createWriteToolDefinition(projectRoot, {
      operations: {
        mkdir: async (dir) => {
          await mkdir(dir, { recursive: true });
        },
        writeFile: async (_absolutePath, content) => {
          const capture = captureStorage.getStore();
          if (!capture) throw new Error("Missing write checkpoint context.");
          capture.before = await captureBefore(capture.relativePath);
          await writeTrackedContent(
            projectRoot,
            capture.relativePath,
            Buffer.from(content, "utf8"),
            capture.before,
            requireStore(),
            (after) => { capture.after = after; },
          );
        },
      },
    });

    pi.registerTool({
      ...writeBase,
      executionMode: "sequential",
      async execute(toolCallId, input, signal, onUpdate, ctx) {
        const { relativePath } = normalizeTrackablePath(projectRoot, input.path);
        // Validate existing components before mkdir/write. Missing files are valid.
        await snapshotPath(projectRoot, relativePath, requireStore());
        const capture: MutationCapture = { toolCallId, toolName: "write", relativePath };
        try {
          const result = await captureStorage.run(capture, () =>
            writeBase.execute(toolCallId, input, signal, onUpdate, ctx),
          );
          await persistMutation(capture);
          return result;
        } catch (error) {
          if (capture.after) await rollbackUnrecorded(capture);
          throw error;
        }
      },
    });
  }

  function appendAnchor(reason: AnchorData["reason"], manifest: Manifest): void {
    const data: AnchorData = {
      version: CHECKPOINT_VERSION,
      kind: "anchor",
      manifest: cloneManifest(manifest),
      reason,
    };
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, data);
  }

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = ctx.cwd;
    const sessionId = ctx.sessionManager.getSessionId();
    store = new BlobStore(join(projectRoot, CONFIG_DIR_NAME, "tree-code-checkpoints", sessionId));
    await store.initialize();
    currentManifest = manifestAt(asEntries(ctx), ctx.sessionManager.getLeafId());
    pendingNavigation = undefined;
    registerTrackedTools();
    ctx.ui.setStatus("tree-code-checkpoint", "tree code checkpoints on");
  });

  pi.on("session_before_tree", async (event, ctx) => {
    pendingNavigation = undefined;
    const entries = asEntries(ctx);
    const targetEntry = ctx.sessionManager.getEntry(event.preparation.targetId) as SessionEntryLike | undefined;
    if (!targetEntry) {
      ctx.ui.notify("Cannot resolve the selected tree node for code restoration.", "error");
      return { cancel: true };
    }
    const targetLeafId = effectiveTreeLeaf(targetEntry);
    const desired = manifestAt(entries, targetLeafId);
    const changedPaths = [...new Set([...Object.keys(currentManifest), ...Object.keys(desired)])]
      .filter((path) => !statesEqual(currentManifest[path], desired[path]));

    if (changedPaths.length === 0) {
      ctx.ui.notify("Code already matches the selected tree node.", "info");
      return;
    }
    if (!ctx.hasUI) {
      return { cancel: true };
    }

    const choice = await ctx.ui.select(
      `切换会话树时如何处理 ${changedPaths.length} 个已追踪文件？`,
      [RESTORE, KEEP, CANCEL],
    );
    if (!choice || choice === CANCEL) {
      ctx.ui.notify("已取消会话树导航；代码未改变。", "info");
      return { cancel: true };
    }

    if (choice === KEEP) {
      pendingNavigation = {
        oldLeafId: event.preparation.oldLeafId,
        mode: "keep",
        desired,
      };
      return;
    }

    try {
      const plan = await buildRestorePlan(projectRoot, currentManifest, desired, requireStore());
      pendingNavigation = {
        oldLeafId: event.preparation.oldLeafId,
        mode: "restore",
        plan,
        desired,
      };
    } catch (error) {
      ctx.ui.notify(`代码恢复预检失败：${errorText(error)}`, "error");
      return { cancel: true };
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    const pending = pendingNavigation;
    pendingNavigation = undefined;
    if (!pending || pending.oldLeafId !== event.oldLeafId) return;

    if (pending.mode === "keep") {
      try {
        appendAnchor("keep", currentManifest);
        ctx.ui.notify("会话已切换；当前代码保持不变。", "info");
      } catch (error) {
        ctx.ui.notify(
          `会话已切换且代码未改变，但无法记录保留状态：${errorText(error)}`,
          "error",
        );
      }
      return;
    }

    const plan = pending.plan;
    if (!plan) return;
    try {
      const result = await applyRestorePlan(projectRoot, plan, requireStore());
      currentManifest = cloneManifest(pending.desired);
      try {
        appendAnchor("restore", currentManifest);
      } catch (appendError) {
        const rollbackPlan: RestorePlan = {
          expected: cloneManifest(pending.desired),
          desired: cloneManifest(plan.expected),
          changedPaths: [...plan.changedPaths],
        };
        await applyRestorePlan(projectRoot, rollbackPlan, requireStore());
        currentManifest = cloneManifest(plan.expected);
        throw new Error(`could not record restored state; files were rolled back: ${errorText(appendError)}`);
      }
      ctx.ui.notify(`已恢复 ${result.changedPaths.length} 个文件到目标节点状态。`, "info");
    } catch (error) {
      // Public Pi APIs do not permit undoing navigation from this notification hook.
      // applyRestorePlan guarantees files are rolled back when its commit fails.
      ctx.ui.notify(
        `会话已切换，但代码恢复失败；文件保持切换前状态：${errorText(error)}`,
        "error",
      );
    }
  });

  pi.registerCommand("tree-checkpoint-status", {
    description: "Show tracked file and checkpoint storage status",
    handler: async (_args, ctx) => {
      const entries = asEntries(ctx);
      const mutationCount = entries.filter(
        (entry) => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE,
      ).length;
      ctx.ui.notify(
        `Tree checkpoints: ${Object.keys(currentManifest).length} tracked file(s), ` +
          `${mutationCount} checkpoint entry/entries. Storage: ${store?.root ?? "not initialized"}`,
        "info",
      );
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("tree-code-checkpoint", undefined);
    pendingNavigation = undefined;
  });
}
