import { createHash } from 'node:crypto';
import path from 'node:path';
import type { EnterpriseActor } from '../../enterprise-gateway.js';
import { OfficeStore, type KnowledgeScope } from '../office-store.js';
import { generateOfficeArtifact } from '../generate.js';
import { inspectArtifact } from '../artifact.js';
import { DataAnalysis, type DataClient } from '../workbook/analysis/service.js';
import { buildOfficeSources, type OfficeReport, type OfficeProvenance } from '../delivery/presentation.js';
import { analysisPresentation, evidencePresentation, verifyPresentationContent } from './build.js';
import { presentationPython } from './index.js';
import { presentationTheme } from './template.js';
import type { PresentationResult } from './types.js';
import { TaskStore } from '../../tasks/store.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
let generating = false;

/** Reuses the existing actor-private OfficeStore and fixed source permissions for derivative PPT files. */
export class BusinessPresentation {
  private constructor(
    private store: OfficeStore,
    private data: DataAnalysis,
    private workspace: string,
    private client: DataClient,
    private origin: string,
    private tasks?: TaskStore
  ) {}
  static async create(root: string, actor: EnterpriseActor, workspace: string, client: DataClient, origin: string) {
    return new BusinessPresentation(
      await OfficeStore.create(root, actor),
      await DataAnalysis.create(root, actor, workspace, client, origin),
      workspace,
      client,
      origin,
      await TaskStore.create(root, actor)
    );
  }
  async result(id: string): Promise<PresentationResult> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('PPT_RESULT_NOT_FOUND');
    const result = (await this.store.businessResult(id)) as PresentationResult | undefined;
    if (!result || result.id !== id) throw new Error('PPT_RESULT_NOT_FOUND');
    await this.authorize(result);
    return result;
  }
  async authorize(result: PresentationResult, scope?: KnowledgeScope) {
    await this.client.me();
    if (result.kind === 'analysis' && result.origin.analysisId)
      await this.data.presentationSource(result.origin.analysisId);
    for (const dependency of result.dependencies) await this.client.authorizedResource(dependency.id, dependency.type);
    for (const file of result.sourceFiles) {
      const bytes = await this.store.download(this.workspace, file.path, file.versionId);
      if (digest(bytes) !== file.sha256) throw new Error('PPT_FIXED_SOURCE_HASH_MISMATCH');
    }
    const checked = new Set<string>();
    for (const source of result.provenance.sources || []) {
      const loc = object(source.locator);
      if (source.kind === 'workspace') {
        const sourceUrl = typeof loc.sourceUrl === 'string' ? new URL(loc.sourceUrl) : undefined;
        if (
          !sourceUrl ||
          sourceUrl.origin !== new URL(this.origin).origin ||
          sourceUrl.pathname !== '/enterprise/files/download'
        )
          throw new Error('PPT_FIXED_WORKSPACE_SOURCE_REQUIRED');
        const file = sourceUrl.searchParams.get('path') || '',
          version = sourceUrl.searchParams.get('version');
        if (!version) throw new Error('PPT_FIXED_WORKSPACE_SOURCE_REQUIRED');
        const key = `${file}:${version}:${loc.sha256}`;
        if (!checked.has(key)) {
          await this.data.guardFile(file);
          if (digest(await this.store.download(this.workspace, file, version)) !== loc.sha256)
            throw new Error('PPT_FIXED_SOURCE_HASH_MISMATCH');
          checked.add(key);
        }
        continue;
      }
      if (source.kind !== 'knowledge') continue;
      if (
        scope &&
        !scope.baseIds.includes(String(loc.baseId)) &&
        !scope.documents.some(
          (d) => d.baseId === loc.baseId && d.documentId === loc.documentId && d.version === loc.version
        )
      )
        throw new Error('SOURCE_OUTSIDE_SELECTED_KNOWLEDGE');
      await this.client.authorizedResource(String(loc.baseId), 'KNOWLEDGE');
      const key = `${loc.documentId}:${loc.version}:${loc.sha256}`;
      if (checked.has(key)) continue;
      const client = this.client;
      if (!client.request) throw new Error('PPT_SOURCE_RECHECK_UNAVAILABLE');
      const response = await client.request(`/ai/knowledge/documents/${loc.documentId}/versions/${loc.version}`);
      const body = object(response.body);
      if (!response.response.ok || body.code !== 200 || object(body.data).sha256 !== loc.sha256)
        throw new Error('PPT_SOURCE_ACCESS_REVOKED');
      checked.add(key);
    }
  }
  async guardFile(name: string, bytes: Buffer) {
    const id = await this.store.businessFileResult(name, digest(bytes));
    if (!id && (await this.store.isBusinessFile(name)))
      throw new Error('PPT_DERIVATIVE_CHANGED_REQUIRES_VERIFIED_REVISION');
    if (id) await this.result(id);
  }
  async linkedResult(name: string, bytes: Buffer): Promise<PresentationResult | undefined> {
    const id = await this.store.businessFileResult(name, digest(bytes));
    return id ? this.result(id) : undefined;
  }
  private async sourceExecution(files: PresentationResult['relatedFiles']) {
    if (!this.tasks) return {};
    const tasks = await this.tasks.list();
    const candidates = tasks
      .flatMap((task) => task.attempts.map((attempt) => ({ task, attempt })))
      .filter(
        ({ attempt }) =>
          files.length > 0 &&
          files.every((file) =>
            attempt.artifacts.some((a) => a.valid && a.path === file.path && a.sha256 === file.sha256)
          )
      )
      .sort((a, b) => a.attempt.createdAt - b.attempt.createdAt);
    const original = candidates[0];
    return original
      ? {
          conversation: original.task.id,
          taskId: original.task.id,
          round: original.attempt.round,
          attempt: original.attempt.attempt,
          attemptId: original.attempt.id,
        }
      : {};
  }
  private async evidence(file: string, _conversation: string): Promise<PresentationResult> {
    if (!file.endsWith('.xlsx') || path.isAbsolute(file)) throw new Error('PPT_EVIDENCE_XLSX_PATH_REQUIRED');
    const excel = await this.store.download(this.workspace, file),
      wordPath = file.replace(/\.xlsx$/, '.docx');
    const word = await this.store.download(this.workspace, wordPath);
    const extracted = await presentationPython<{ title: string; report: OfficeReport; provenance: OfficeProvenance }>(
      'extract',
      excel,
      { word }
    );
    const key = extracted.provenance.dataSha256!;
    if (
      (await this.store.deliveryReceipt(key, file)) !== digest(excel) ||
      (await this.store.deliveryReceipt(key, wordPath)) !== digest(word)
    )
      throw new Error('PPT_REQUIRE_VERIFIED_DELIVERY_CURRENT_PAIR');
    const catalog = buildOfficeSources(extracted.provenance.sources);
    const presentation = evidencePresentation(extracted.title, extracted.report, catalog.entries, extracted.provenance);
    const existing = (await this.store.businessResult(presentation.id)) as PresentationResult | undefined;
    if (existing) {
      await this.authorize(existing);
      return existing;
    }
    const relatedFiles = [];
    for (const name of [wordPath, file]) {
      const receipt = await this.store.fileReceipt(name);
      if (!receipt) throw new Error('PPT_SOURCE_VERSION_REQUIRED');
      relatedFiles.push({ path: name, ...receipt });
    }
    const dependencies = [
      ...new Set(
        extracted.provenance.sources.filter((s) => s.kind === 'knowledge').map((s) => String(object(s.locator).baseId))
      ),
    ].map((id) => ({ id, type: 'KNOWLEDGE' as const }));
    const result: PresentationResult = {
      ...presentation,
      relatedFiles,
      dependencies,
      sourceFiles: relatedFiles.map((f) => ({ path: f.path, versionId: f.versionId, sha256: f.sha256 })),
      origin: {
        ...(await this.sourceExecution(relatedFiles)),
        createdAt: relatedFiles[0].createdAt,
        originalDataSha256: key,
      },
    };
    await this.authorize(result);
    await this.store.saveBusinessResult(result.id, result);
    return result;
  }
  private async receipt(name: string, bytes: Buffer, versionId?: string) {
    const receipt = await this.store.fileReceipt(name, versionId);
    if (!receipt || receipt.sha256 !== digest(bytes)) throw new Error('PPT_RECEIPT_MISSING');
    const query = new URLSearchParams({ path: name, version: receipt.versionId });
    const downloadUrl = new URL('/enterprise/files/download?' + query, this.origin).href;
    const previewUrl = new URL(
      '/#/workspace?' + new URLSearchParams({ section: 'files', previewPath: name, fileVersion: receipt.versionId }),
      this.origin
    ).href;
    return {
      path: name,
      ...receipt,
      downloadUrl,
      previewUrl,
      valid: true,
      validation: { valid: true },
      receiptText: `${path.basename(name)} · v${receipt.version}\n[预览](${previewUrl}) [下载](${downloadUrl})`,
    };
  }
  async relatedReceipts(result: PresentationResult, signal?: AbortSignal) {
    await this.authorize(result);
    const receipts = [];
    for (const file of result.relatedFiles) {
      const bytes = await this.store.download(this.workspace, file.path, file.versionId);
      if (digest(bytes) !== file.sha256) throw new Error('PPT_LINKED_FILE_HASH_MISMATCH');
      await inspectArtifact(file.path, bytes, signal);
      receipts.push(await this.receipt(file.path, bytes, file.versionId));
    }
    return receipts;
  }
  async generate(
    input: { analysisId?: string; evidencePath?: string; path?: string; templateId?: string; overwrite?: boolean },
    execution: { conversation: string; attemptId?: string; round?: number; attempt?: number },
    signal?: AbortSignal,
    scope?: KnowledgeScope
  ) {
    if (generating) throw new Error('PPT_GENERATOR_BUSY_RETRY');
    if (!!input.analysisId === !!input.evidencePath) throw new Error('PPT_SELECT_ONE_VERIFIED_RESULT');
    generating = true;
    let result: PresentationResult | undefined;
    try {
      if (input.analysisId) {
        let analysis = await this.data.presentationSource(input.analysisId);
        if (analysis.artifacts.length < 2) {
          await this.data.generate(input.analysisId, undefined, signal);
          analysis = await this.data.presentationSource(input.analysisId);
        }
        const candidate = analysisPresentation(analysis);
        result = (await this.store.businessResult(candidate.id)) as PresentationResult | undefined;
        if (!result) {
          result = candidate;
          result.origin = { ...result.origin, ...(await this.sourceExecution(result.relatedFiles)) };
          await this.store.saveBusinessResult(result.id, result);
        }
      } else result = await this.evidence(input.evidencePath!, execution.conversation);
      await this.authorize(result, scope);
      signal?.throwIfAborted();
      const theme = await presentationTheme(this.client, input.templateId, signal);
      const name =
        input.path ||
        (result.relatedFiles[0]?.path.replace(/\.(docx|xlsx)$/i, '') || '演示/' + result.id.slice(0, 12)) + '.pptx';
      if (
        !name.endsWith('.pptx') ||
        name.length > 200 ||
        path.isAbsolute(name) ||
        name.split('/').some((s) => !s || s === '.' || s === '..') ||
        name.includes('\\') ||
        [...name].some((character) => (character.codePointAt(0) ?? 0) < 32)
      )
        throw new Error('PPT_OUTPUT_PATH_INVALID');
      const deliveryKey = digest(
        JSON.stringify({ resultId: result.id, resultHash: result.resultHash, template: theme.sha256 })
      );
      const old = await this.store.fileReceipt(name);
      if (old && (await this.store.deliveryReceipt(deliveryKey, name)) === old.sha256) {
        const bytes = await this.store.download(this.workspace, name);
        await this.guardFile(name, bytes);
        return {
          status: 'complete',
          reused: true,
          resultId: result.id,
          resultHash: result.resultHash,
          files: [...(await this.relatedReceipts(result, signal)), await this.receipt(name, bytes)],
          template: { name: theme.name, version: theme.version, resourceVersion: theme.resourceVersion },
        };
      }
      if (old && !input.overwrite) throw new Error('PPT_OUTPUT_EXISTS_USE_NEW_PATH_OR_EXPLICIT_OVERWRITE');
      const template = {
        name: theme.name,
        version: theme.version,
        resourceId: theme.resourceId,
        resourceVersion: theme.resourceVersion,
        sha256: theme.sha256,
      };
      const provenance = {
        ...result.provenance,
        businessResult: {
          id: result.id,
          resultHash: result.resultHash,
          kind: result.kind,
          origin: { ...result.origin, presentationExecution: execution },
          relatedFiles: result.relatedFiles,
          template,
        },
      };
      const bytes = await generateOfficeArtifact(
        {
          format: 'pptx',
          title: result.title,
          slides: result.slides,
          sources: result.sources,
          provenance,
          presentationTheme: theme,
        },
        signal
      );
      const quality = await presentationPython('inspect', bytes, { signal });
      verifyPresentationContent(result, quality);
      await inspectArtifact(name, bytes, signal);
      await this.authorize(result, scope);
      await this.client.me();
      signal?.throwIfAborted();
      // Dependency is durable before bytes can become visible, including a crash between commits.
      await this.store.linkBusinessFile(name, digest(bytes), result.id);
      await this.store.upload(this.workspace, name, bytes, Boolean(old), old?.sha256);
      const saved = await this.store.download(this.workspace, name);
      if (!saved.equals(bytes)) throw new Error('FILE_CHANGED_RETRY');
      await this.store.rememberDelivery(deliveryKey, name, digest(saved));
      return {
        status: 'complete',
        resultId: result.id,
        resultHash: result.resultHash,
        template,
        files: [...(await this.relatedReceipts(result, signal)), await this.receipt(name, saved)],
        quality: {
          slideCount: quality.slideCount,
          nativeCharts: quality.nativeCharts,
          nativeTables: quality.nativeTables,
          editableTextShapes: quality.editableTextShapes,
          reopened: true,
        },
        requiredDeliverables: [name],
        instruction:
          'PPT generated from fixed verified result; related Word/Excel retain their exact versions. Use actual receipts. File delivery success does not erase partial Agent attempts. No new calculation or claim of WPS/PowerPoint acceptance.',
      };
    } catch (error) {
      if (!result || signal?.aborted) throw error;
      await this.authorize(result, scope);
      return {
        status: 'partial',
        error: (error as Error).message,
        resultId: result.id,
        resultHash: result.resultHash,
        files: await this.relatedReceipts(result, signal),
        instruction:
          'PPT failed. Existing verified Word/Excel remain available; retry only this PPT using the same result. Do not overwrite successful files or mark Agent history completed.',
      };
    } finally {
      generating = false;
    }
  }
}
