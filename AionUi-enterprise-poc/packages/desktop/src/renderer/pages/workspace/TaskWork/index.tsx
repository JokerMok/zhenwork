import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Input,
  Link,
  Message,
  Space,
  Select,
  Tag,
  Upload,
} from "@arco-design/web-react";
import type { UploadRequest } from "@arco-design/web-react/es/Upload/interface";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { isEnterpriseWeb } from "@/renderer/utils/platform";
import WebKnowledgePicker from "@/renderer/components/chat/SendBox/WebKnowledgePicker";
import { enterpriseRequest, uploadWorkspaceFiles, workspaceErrorCode } from "../workspaceApi";
import { taskAccepted, taskRequestId, useTaskWork } from "./api";

export default function TaskWork({
  conversationId,
  composer = false,
}: {
  conversationId: string;
  composer?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { task, attempt: a, error, reload } = useTaskWork(conversationId);
  const [input, setInput] = useState(""),
    [files, setFiles] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string>(),
    [reviewed, setReviewed] = useState(false),
    [replaceRequirements,setReplaceRequirements] = useState(false),
    [externalOutcome, setExternalOutcome] = useState<string>();
  const previous = useRef<string | undefined>(undefined);
  useEffect(()=>{
    setInput("");setFiles([]);setReviewed(false);setReplaceRequirements(false);
    setExternalOutcome(undefined);setFailure(undefined);previous.current=undefined;
  },[conversationId]);
  useEffect(() => {
    if (a) {
      const value = a.id + ":" + a.state;
      if (
        previous.current &&
        previous.current !== value &&
        [
          "completed",
          "partial",
          "waiting_input",
          "waiting_confirmation",
          "failed",
          "interrupted",
        ].includes(a.state)
      )
        Message.info(
          t("workspace.work.changed", {
            status: t(`workspace.work.states.${a.state}`, { defaultValue: a.state }),
          }),
        );
      previous.current = value;
    }
  }, [a?.id, a?.state, t]);
  if (!isEnterpriseWeb()) return null;
  if (!task || !a)
    return error ? (
      <Alert
        type="error"
        content={t("workspace.errors.load", { code: error })}
        action={<Button onClick={() => void reload()}>{t("common.retry")}</Button>}
      />
    ) : null;
  const active = ["queued", "running", "cancelling"].includes(a.state);
  const action = async (kind: string) => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const payload = {
        attemptId: a.id,
        content: input,
        files: files.map((path) => ({ kind: "local", path })),
        reviewed,
        externalOutcome,
        replaceRequirements,
        language: i18n.language,
      };
      const request_id = await taskRequestId(conversationId, { kind, ...payload });
      await enterpriseRequest(`/enterprise/tasks/${conversationId}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, request_id }),
      });
      taskAccepted(conversationId);
      setInput("");
      setFiles([]);
      setReviewed(false);
      setReplaceRequirements(false);
      setExternalOutcome(undefined);
      await reload();
    } catch (e) {
      setFailure(workspaceErrorCode(e));
    } finally {
      setBusy(false);
    }
  };
  const upload: UploadRequest = async ({ file, onSuccess, onError }) => {
    try {
      const value = await uploadWorkspaceFiles([file as File]);
      if (value.failed.length) throw new Error(value.failed[0].error);
      setFiles((old) => [...old, ...value.uploaded]);
      onSuccess?.({});
    } catch (e) {
      onError?.(e as Error);
      setFailure(workspaceErrorCode(e));
    }
  };
  const status = t(`workspace.work.states.${a.state}`, {
    defaultValue: t("workspace.work.unknown"),
  });
  return (
    <section
      data-testid="task-work"
      className="border border-solid border-b-base rd-8px p-12px flex flex-col gap-8px min-w-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-8px">
        <Space>
          <Tag>{status}</Tag>
          <span className="text-12px text-t-secondary">
            {t("workspace.work.round", { round: a.round, attempt: a.attempt })}
          </span>
        </Space>
        <span className="text-12px text-t-secondary">
          {new Intl.DateTimeFormat(i18n.language, {
            dateStyle: "short",
            timeStyle: "short",
          }).format(new Date(a.updatedAt))}
        </span>
      </div>
      {a.question ? (
        <Alert type="warning" content={a.question} />
      ) : a.progress ? (
        <span className="text-13px text-t-secondary break-words">
          {t(`workspace.work.progress.${a.progress}`, { defaultValue: a.progress })}
        </span>
      ) : null}
      {a.reason ? (
        <Alert
          type={a.state === "queued" ? "info" : "warning"}
          content={t(`workspace.work.reasons.${a.reason}`, {
            defaultValue: t("workspace.work.reasons.TASK_EXECUTION_UNAVAILABLE"),
          })}
        />
      ) : null}
      <Space wrap>
        {a.artifacts.map((f) => (
          <Space key={f.path}>
            <Tag color={f.valid ? "green" : "orange"}>
              {f.valid ? `${f.path}${f.version ? " · v"+f.version : ""}` : t("workspace.work.pendingArtifact", { path: f.path })}
            </Tag>
            {f.valid && f.previewUrl ? (
              <Button type="text" onClick={() => navigate(f.previewUrl!.replace(/^\/#/, ""))}>
                {t("workspace.files.preview")}
              </Button>
            ) : null}
            {f.valid && f.downloadUrl ? (
              <Link href={f.downloadUrl} download>
                {t("common.download")}
              </Link>
            ) : null}
          </Space>
        ))}
      </Space>
      {a.assistant ? <Tag>{a.assistant.name}</Tag> : null}
      <Collapse className="max-h-180px overflow-y-auto">
        <Collapse.Item name="steps" header={t("workspace.work.details")}>
          {a.confirmation?.proposal ? (
            <pre className="whitespace-pre-wrap break-words text-12px">
              {a.confirmation.proposal}
            </pre>
          ) : null}
          {a.inputs?.content ? (
            <p className="whitespace-pre-wrap break-words">{a.inputs.content}</p>
          ) : null}
          {a.inputs?.files?.length ? (
            <Space wrap>
              {a.inputs.files.map((f, i) => (
                <Tag key={i}>{(f.path || f.relative_path || "").split(/[\\/]/).at(-1)}</Tag>
              ))}
            </Space>
          ) : null}
          {a.steps.length ? (
            a.steps.map((s) => (
              <div key={s.id} className="py-4px break-words">
                <Tag>{t(`workspace.work.step.${s.state}`, { defaultValue: s.state })}</Tag> {s.tool}
                {s.state === "failed" ? ` · ${s.summary}` : ""}
              </div>
            ))
          ) : (
            <span className="text-t-secondary">{t("workspace.work.noSteps")}</span>
          )}
          {a.scope ? (
            <div className="mt-8px text-12px text-t-secondary">
              {t("workspace.work.scope", {
                bases: a.scope.baseIds.length,
                documents: a.scope.documents.length,
              })}{" "}
              {a.scope.documents.map((d) => `v${d.version}`).join(" · ")}
            </div>
          ) : null}
        </Collapse.Item>
        {task.attempts.length > 1 ? (
          <Collapse.Item name="history" header={t("workspace.work.history")}>
            {task.attempts.slice(0, -1).map((old) => (
              <div key={old.id} className="py-8px border-b border-solid border-b-base">
                <Space>
                  <Tag>
                    {t(`workspace.work.states.${old.state}`, {
                      defaultValue: t("workspace.work.unknown"),
                    })}
                  </Tag>
                  <span>
                    {t("workspace.work.round", { round: old.round, attempt: old.attempt })}
                  </span>
                </Space>
                {old.question ? <p>{old.question}</p> : null}
                <Space wrap>
                  {old.artifacts
                    .filter((f) => f.valid)
                    .map((f) => (
                      <Space key={f.path}>
                        <span>{f.path}</span>
                        {f.previewUrl ? (
                          <Button
                            type="text"
                            onClick={() => navigate(f.previewUrl!.replace(/^\/#/, ""))}
                          >
                            {t("workspace.files.preview")}
                          </Button>
                        ) : null}
                        {f.downloadUrl ? (
                          <Link href={f.downloadUrl} download>
                            {t("common.download")}
                          </Link>
                        ) : null}
                      </Space>
                    ))}
                </Space>
              </div>
            ))}
          </Collapse.Item>
        ) : null}
      </Collapse>
      {failure ? (
        <Alert
          type="error"
          content={t(`workspace.work.errors.${failure}`, {
            defaultValue: t("workspace.errors.action", { code: failure }),
          })}
        />
      ) : null}
      <Space wrap>
        <Button onClick={() => navigate(`/conversation/${conversationId}`)}>
          {t("workspace.tasks.open")}
        </Button>
        {[
          "queued",
          "running",
          "cancelling",
          "waiting_input",
          "waiting_confirmation",
          "interrupted",
        ].includes(a.state) ? (
          <Button
            status="danger"
            disabled={a.state === "cancelling"}
            loading={busy}
            onClick={() => void action("cancel")}
          >
            {t(a.state === "cancelling" ? "workspace.work.stopping" : "common.cancel")}
          </Button>
        ) : null}
        {["partial", "failed", "interrupted"].includes(a.state) ? (
          <Button
            loading={busy}
            disabled={
              a.state === "interrupted" &&
              (!reviewed || (a.requiresExternalReview && !externalOutcome))
            }
            onClick={() => void action("retry")}
          >
            {t("workspace.work.retryRemaining")}
          </Button>
        ) : null}
      </Space>
      {a.state === "interrupted" ? (
        <Checkbox checked={reviewed} onChange={setReviewed}>
          {t("workspace.work.reviewRecovery")}
        </Checkbox>
      ) : null}
      {a.state === "interrupted" && a.requiresExternalReview ? (
        <div className="flex flex-col gap-8px">
          <Alert type="warning" content={t("workspace.work.externalReview")} />
          <Select
            aria-label={t("workspace.work.externalReview")}
            value={externalOutcome}
            placeholder={t("workspace.work.externalReview")}
            onChange={setExternalOutcome}
          >
            <Select.Option value="applied">{t("workspace.work.externalApplied")}</Select.Option>
            <Select.Option value="not_applied">
              {t("workspace.work.externalNotApplied")}
            </Select.Option>
          </Select>
        </div>
      ) : null}
      {!active && (composer || a.state === "waiting_confirmation") ? (
        <div className="flex flex-col gap-8px">
          <WebKnowledgePicker conversationId={conversationId} />
          {!["completed","cancelled"].includes(a.state) ? <Checkbox checked={replaceRequirements} onChange={setReplaceRequirements}>{t("workspace.work.replaceRequirements")}</Checkbox> : null}
          <Input.TextArea
            aria-label={t("workspace.work.continuation")}
            value={input}
            onChange={setInput}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t("workspace.work.continuation")}
          />
          <Space wrap>
            <Upload multiple showUploadList={false} customRequest={upload}>
              <Button>{t("workspace.files.upload")}</Button>
            </Upload>
            {files.map((f) => (
              <Tag key={f} closable onClose={() => setFiles((old) => old.filter((x) => x !== f))}>
                {f}
              </Tag>
            ))}
          </Space>
          <Space>
            {a.state === "waiting_confirmation" && a.canApprove === false ? (
              <Alert
                type="warning"
                content={t("workspace.work.errors.TASK_APPROVAL_DETAILS_UNAVAILABLE")}
              />
            ) : null}
            {a.state === "waiting_confirmation" ? (
              <>
                <Button
                  type="primary"
                  disabled={a.canApprove === false}
                  loading={busy}
                  onClick={() => void action("approve")}
                >
                  {t("workspace.work.approve")}
                </Button>
                <Button loading={busy} onClick={() => void action("decline")}>
                  {t("workspace.work.decline")}
                </Button>
              </>
            ) : (
              <Button
                type="primary"
                loading={busy}
                disabled={
                  !input.trim() ||
                  (a.state === "interrupted" &&
                    (!reviewed || (a.requiresExternalReview && !externalOutcome)))
                }
                onClick={() => void action("continue")}
              >
                {t("workspace.work.continue")}
              </Button>
            )}
          </Space>
        </div>
      ) : null}
    </section>
  );
}
