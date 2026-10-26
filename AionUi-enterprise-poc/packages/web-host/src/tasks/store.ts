import { mkdir, lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EnterpriseActor } from "../enterprise-gateway.js";
import { enterpriseManagedResourcePath } from "../enterprise-resource-runtime.js";
import {
  activeStates,
  currentAttempt,
  digest,
  requiredFormats,
  requiresToolEvidence,
  TaskError,
  type TaskRecord,
  type TaskAttempt,
} from "./types.js";

/** One supervisor owns this host-only control tree. Atomic fsync/rename is the durable transaction boundary. */
export class TaskStore {
  private static stores = new Map<string, Promise<TaskStore>>();
  private sequence: Promise<unknown> = Promise.resolve();
  private constructor(private readonly file: string) {}
  static async create(root: string, actor: EnterpriseActor): Promise<TaskStore> {
    const file = path.join(
      path.dirname(await enterpriseManagedResourcePath(root, actor)),
      "tasks",
      "tasks.json",
    );
    let pending = this.stores.get(file);
    if (!pending) {
      pending = (async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        return new TaskStore(file);
      })();
      this.stores.set(file, pending);
    }
    return pending;
  }
  async list(): Promise<TaskRecord[]> {
    const pending = this.sequence;
    await pending.catch(() => {});
    return this.read();
  }
  private async read(): Promise<TaskRecord[]> {
    const stat = await lstat(this.file).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat) return [];
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 24 * 1024 * 1024
    )
      throw new TaskError(503, "TASK_STORE_UNAVAILABLE");
    const data = JSON.parse(await readFile(this.file, "utf8")) as {
      schema: number;
      tasks: TaskRecord[];
    };
    if (
      data.schema !== 1 ||
      !Array.isArray(data.tasks) ||
      data.tasks.length > 500 ||
      new Set(data.tasks.map((t) => t.id)).size !== data.tasks.length
    )
      throw new TaskError(503, "TASK_STORE_INVALID");
    return data.tasks;
  }
  async transaction<T>(fn: (tasks: TaskRecord[]) => Promise<T> | T): Promise<T> {
    const run = this.sequence.then(async () => {
      const tasks = await this.read();
      const result = await fn(tasks);
      const raw = JSON.stringify({ schema: 1, tasks });
      if (Buffer.byteLength(raw) > 24 * 1024 * 1024)
        throw new TaskError(409, "TASK_HISTORY_CAPACITY");
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        const f = await open(temporary, "wx", 0o600);
        try {
          await f.writeFile(raw);
          await f.sync();
        } finally {
          await f.close();
        }
        await rename(temporary, this.file);
        const dir = await open(path.dirname(this.file), "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
      return result;
    });
    this.sequence = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  async get(id: string): Promise<TaskRecord> {
    const task = (await this.list()).find((t) => t.id === id);
    if (!task) throw new TaskError(404, "TASK_NOT_FOUND");
    return task;
  }
  async mutate(
    id: string,
    attemptId: string,
    fn: (a: TaskAttempt, t: TaskRecord) => void,
  ): Promise<void> {
    return this.transaction((tasks) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new TaskError(404, "TASK_NOT_FOUND");
      const a = currentAttempt(task);
      if (a.id !== attemptId) return;
      fn(a, task);
      a.updatedAt = task.updatedAt = Date.now();
    });
  }
  async accept(
    id: string,
    requestId: string,
    payload: Record<string, unknown>,
    retry = false,
  ): Promise<{ task: TaskRecord; duplicate: boolean }> {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
      !/^[0-9a-f-]{36}$/i.test(requestId) ||
      typeof payload.content !== "string" ||
      !payload.content.trim() ||
      payload.content.length > 64000
    )
      throw new TaskError(400, "TASK_INPUT_INVALID");
    const hash = digest(payload);
    return this.transaction((tasks) => {
      const seen = tasks
        .flatMap((t) => t.attempts.map((a) => ({ t, a })))
        .find((x) => x.a.requestId === requestId);
      if (seen) {
        if (seen.t.id !== id || seen.a.payloadHash !== hash)
          throw new TaskError(409, "TASK_REQUEST_CONFLICT");
        if (currentAttempt(seen.t).id !== seen.a.id)
          throw new TaskError(409, "TASK_REQUEST_SUPERSEDED");
        return { task: seen.t, duplicate: true };
      }
      let task = tasks.find((t) => t.id === id);
      const prior = task ? currentAttempt(task) : undefined;
      if (prior && activeStates.has(prior.state)) {
        if (prior.payloadHash === hash) return { task: task!, duplicate: true };
        throw new TaskError(409, "TASK_BUSY");
      }
      if (!task) {
        if (tasks.length >= 500) throw new TaskError(409, "TASK_HISTORY_CAPACITY");
        task = {
          id,
          title: String(payload.content).slice(0, 80),
          updatedAt: Date.now(),
          attempts: [],
        };
        tasks.push(task);
      }
      if (task.attempts.length >= 50) throw new TaskError(409, "TASK_ATTEMPT_CAPACITY");
      const uuid = randomUUID();
      const now = Date.now();
      task.attempts.push({
        id: uuid,
        requestId,
        payloadHash: hash,
        round: retry && prior ? prior.round : (prior?.round || 0) + 1,
        attempt: retry && prior ? prior.attempt + 1 : 1,
        jobId: "task_" + uuid,
        state: "queued",
        phase: "authorizing",
        createdAt: now,
        updatedAt: now,
        payload,
        steps: [],
        artifacts: retry && prior ? [...prior.artifacts] : [],
        requiredFormats:
          retry && prior ? [...prior.requiredFormats] : requiredFormats(String(payload.content)),
        requiresToolEvidence:
          retry && prior
            ? prior.requiresToolEvidence
            : requiresToolEvidence(String(payload.content), payload.files),
        ...(retry && prior ? { retryOf: prior.id } : {}),
      });
      task.updatedAt = now;
      return { task, duplicate: false };
    });
  }
}
