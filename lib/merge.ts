import type { Annotation, AnnotationPackage, TextDocument } from './types';

export interface PackageMergeReport {
  ok: boolean;
  error?: string;
  /** 新增条目数。 */
  added: number;
  /** 同一条目（originId 命中）更新数。 */
  updated: number;
  /** 本地已解决、保留取舍而跳过的条目数。 */
  preserved: number;
  /** 内容未变、无需处理的条目数。 */
  unchanged: number;
  /** 引用目标失效的条目数。 */
  invalidated: number;
  total: number;
  packageId?: string;
  label?: string;
  alreadyImported?: boolean;
}

const KINDS = ['footnote', 'variant', 'background', 'crossref'];
const ANCHOR_TYPES = ['chapter', 'sentence', 'word'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: string): PackageMergeReport {
  return { ok: false, error, added: 0, updated: 0, preserved: 0, unchanged: 0, invalidated: 0, total: 0 };
}

function validatePackage(raw: unknown): { ok: true; pkg: AnnotationPackage } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: '批注包必须是 JSON 对象。' };
  const pkg = raw as Record<string, unknown>;
  if (typeof pkg.packageId !== 'string' || !pkg.packageId.trim()) return { ok: false, error: '批注包缺少 packageId。' };
  if (typeof pkg.label !== 'string' || !pkg.label.trim()) return { ok: false, error: '批注包缺少 label。' };
  if (!Array.isArray(pkg.annotations)) return { ok: false, error: '批注包缺少 annotations 数组。' };
  for (let i = 0; i < pkg.annotations.length; i++) {
    const a = pkg.annotations[i];
    if (!isRecord(a)) return { ok: false, error: `第 ${i + 1} 条注释格式不正确。` };
    if (typeof a.id !== 'string' || !a.id.trim()) return { ok: false, error: `第 ${i + 1} 条注释缺少 id。` };
    if (typeof a.anchorId !== 'string' || !a.anchorId.trim()) return { ok: false, error: `第 ${i + 1} 条注释缺少 anchorId。` };
    if (typeof a.anchorType !== 'string' || !ANCHOR_TYPES.includes(a.anchorType)) {
      return { ok: false, error: `第 ${i + 1} 条注释 anchorType 非法。` };
    }
    if (typeof a.kind !== 'string' || !KINDS.includes(a.kind)) {
      return { ok: false, error: `第 ${i + 1} 条注释 kind 非法。` };
    }
    if (typeof a.source !== 'string') return { ok: false, error: `第 ${i + 1} 条注释缺少 source。` };
    if (typeof a.title !== 'string') return { ok: false, error: `第 ${i + 1} 条注释缺少 title。` };
    if (typeof a.body !== 'string') return { ok: false, error: `第 ${i + 1} 条注释缺少 body。` };
  }
  return { ok: true, pkg: raw as unknown as AnnotationPackage };
}

function anchorExists(document: TextDocument, annotation: Annotation): boolean {
  if (annotation.anchorType === 'chapter') {
    return document.chapters.some((chapter) => chapter.id === annotation.anchorId);
  }
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      if (annotation.anchorType === 'sentence' && sentence.id === annotation.anchorId) return true;
      if (annotation.anchorType === 'word' && sentence.tokens.some((token) => token.id === annotation.anchorId)) {
        return true;
      }
    }
  }
  return false;
}

/** 句子正文是否被本地修订（以包内句子快照为准）。 */
function sentenceTextChanged(document: TextDocument, annotation: Annotation, snapshots: Map<string, string>): boolean {
  if (annotation.anchorType !== 'word') return false;
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      if (sentence.tokens.some((token) => token.id === annotation.anchorId)) {
        const snapshot = snapshots.get(sentence.id);
        return snapshot !== undefined && snapshot !== sentence.text;
      }
    }
  }
  return false;
}

function sameContent(a: Annotation, b: Annotation): boolean {
  return a.title === b.title && a.body === b.body && a.kind === b.kind && a.source === b.source;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 将离线批注包合并进文档。合并键为「锚点 + 注释类型 + 来源」，originId 用于同一条目的幂等更新。
 * - 本地已解决（conflictState === 'resolved'）的条目不覆盖，保留取舍。
 * - 两边都改过且未解决的条目按来源列出（保留本地，另增来源条目），冲突由校勘面板重算。
 * - 引用目标失效的条目标记 invalid，不覆盖正文。
 * 校验失败时不修改文档，调用方可保留整批供重试。
 */
export function mergePackage(document: TextDocument, raw: unknown): PackageMergeReport {
  const validation = validatePackage(raw);
  if (!validation.ok) return fail(validation.error);
  const pkg = validation.pkg;

  const snapshots = new Map<string, string>();
  for (const sentence of pkg.sentences ?? []) snapshots.set(sentence.id, sentence.text);

  const alreadyImported = document.importedPackages.some((record) => record.packageId === pkg.packageId);

  let added = 0;
  let updated = 0;
  let preserved = 0;
  let unchanged = 0;
  let invalidated = 0;

  for (const incoming of pkg.annotations) {
    const originId = incoming.originId ?? `${pkg.packageId}:${incoming.id}`;
    const candidate: Annotation = { ...incoming, originId };

    // 先按 originId 命中同一条目，再按「锚点 + 类型 + 来源」命中重复条目。
    let local = document.annotations.find((item) => item.originId === originId);
    if (!local) {
      local = document.annotations.find(
        (item) =>
          item.anchorId === incoming.anchorId &&
          item.anchorType === incoming.anchorType &&
          item.kind === incoming.kind &&
          item.source === incoming.source
      );
    }

    const exists = anchorExists(document, candidate);
    if (!exists) {
      candidate.invalid = true;
      candidate.invalidReason = sentenceTextChanged(document, candidate, snapshots)
        ? '句子正文已改动，原词语引用失效'
        : '引用目标已不存在';
      invalidated += 1;
    }

    if (local) {
      if (local.conflictState === 'resolved') {
        // 保留本地已解决的取舍，不覆盖校记与交叉引用。
        preserved += 1;
        continue;
      }
      if (sameContent(local, candidate)) {
        unchanged += 1;
        continue;
      }
      if (local.originId === originId) {
        // 同一条目再次导入：以包内内容为准更新，不新增记录。
        Object.assign(local, candidate, { id: local.id });
        updated += 1;
      } else {
        // 两边都改过且未解决：保留本地，另增一条来源条目，交由校勘面板按来源列出。
        document.annotations.push({
          ...candidate,
          id: uniqueId('annotation'),
          importedFrom: { packageId: pkg.packageId, label: pkg.label }
        });
        added += 1;
      }
    } else {
      let id = incoming.id;
      if (document.annotations.some((item) => item.id === id)) id = uniqueId('annotation');
      const record: Annotation = {
        ...candidate,
        id,
        importedFrom: { packageId: pkg.packageId, label: pkg.label }
      };
      if (id !== incoming.id) {
        record.references = incoming.references.map((reference) => (reference === incoming.id ? id : reference));
      }
      document.annotations.push(record);
      added += 1;
    }
  }

  if (!alreadyImported) {
    document.importedPackages.push({
      packageId: pkg.packageId,
      label: pkg.label,
      importedAt: new Date().toISOString(),
      annotationCount: pkg.annotations.length
    });
  }

  return {
    ok: true,
    added,
    updated,
    preserved,
    unchanged,
    invalidated,
    total: pkg.annotations.length,
    packageId: pkg.packageId,
    label: pkg.label,
    alreadyImported
  };
}

/** 导出当前文档的离线批注包（含句子正文快照，供离线批注与失效检测）。 */
export function buildPackageFromDocument(document: TextDocument): AnnotationPackage {
  return {
    packageId: `pkg-${Date.now().toString(36)}`,
    label: `${document.title} · 离线批注包`,
    exportedAt: new Date().toISOString(),
    note: '由整理工作台导出，可离线批注后带回合并。',
    sentences: document.chapters.flatMap((chapter) =>
      chapter.sentences.map((sentence) => ({ id: sentence.id, text: sentence.text }))
    ),
    annotations: document.annotations.map((annotation) => ({ ...annotation }))
  };
}
