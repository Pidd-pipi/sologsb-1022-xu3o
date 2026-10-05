import type {
  AnchorType,
  Annotation,
  AnnotationPackage,
  ImportedPackageRecord,
  ImportPlanItem,
  ImportReport,
  PackageAnnotation,
  TextDocument
} from './types';

const VALID_KINDS = new Set(['footnote', 'variant', 'background', 'crossref']);
const VALID_ANCHOR_TYPES = new Set(['chapter', 'sentence', 'word']);

export class PackageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageParseError';
  }
}

/** 解析离线批注包；结构非法时抛出带原因的错误，整批原文留给外层重试。 */
export function parseAnnotationPackage(raw: string): AnnotationPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PackageParseError(`JSON 无法解析：${error instanceof Error ? error.message : '格式错误'}`);
  }

  const pkg = parsed as Partial<AnnotationPackage> | null;
  if (!pkg || typeof pkg !== 'object') {
    throw new PackageParseError('批注包必须是 JSON 对象。');
  }
  if (typeof pkg.packageId !== 'string' || !pkg.packageId.trim()) {
    throw new PackageParseError('缺少 packageId，无法登记去重。');
  }
  if (typeof pkg.label !== 'string' || !pkg.label.trim()) {
    throw new PackageParseError('缺少包名称 label。');
  }
  if (!Array.isArray(pkg.annotations)) {
    throw new PackageParseError('annotations 必须是数组。');
  }

  const annotations: PackageAnnotation[] = [];
  pkg.annotations.forEach((entry, index) => {
    const item = entry as Partial<PackageAnnotation> | null;
    const where = `第 ${index + 1} 条`;
    if (!item || typeof item !== 'object') throw new PackageParseError(`${where}不是对象。`);
    if (typeof item.anchorId !== 'string' || !item.anchorId.trim()) {
      throw new PackageParseError(`${where}缺少 anchorId。`);
    }
    if (!item.anchorType || !VALID_ANCHOR_TYPES.has(item.anchorType)) {
      throw new PackageParseError(`${where}anchorType 非法。`);
    }
    if (!item.kind || !VALID_KINDS.has(item.kind)) {
      throw new PackageParseError(`${where}kind 非法。`);
    }
    if (typeof item.title !== 'string' || !item.title.trim()) {
      throw new PackageParseError(`${where}缺少标题。`);
    }
    if (typeof item.body !== 'string' || !item.body.trim()) {
      throw new PackageParseError(`${where}缺少正文。`);
    }
    annotations.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
      anchorId: item.anchorId.trim(),
      anchorType: item.anchorType as AnchorType,
      kind: item.kind as PackageAnnotation['kind'],
      title: item.title.trim(),
      body: item.body.trim(),
      source: typeof item.source === 'string' && item.source.trim() ? item.source.trim() : '未署来源',
      references: Array.isArray(item.references)
        ? item.references.filter((ref): ref is string => typeof ref === 'string' && !!ref.trim())
        : [],
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim())
        : []
    });
  });

  return {
    packageId: pkg.packageId.trim(),
    label: pkg.label.trim(),
    source: typeof pkg.source === 'string' && pkg.source.trim() ? pkg.source.trim() : '未署整理组',
    exportedAt: typeof pkg.exportedAt === 'string' ? pkg.exportedAt : undefined,
    annotations
  };
}

interface ResolvedAnchor {
  anchorId: string;
  anchorType: AnchorType;
  valid: boolean;
  migratedWord?: boolean;
}

function resolveAnchor(document: TextDocument, incoming: PackageAnnotation): ResolvedAnchor {
  const { anchorId, anchorType } = incoming;
  if (anchorType === 'chapter') {
    return document.chapters.some((chapter) => chapter.id === anchorId)
      ? { anchorId, anchorType, valid: true }
      : { anchorId, anchorType, valid: false };
  }
  if (anchorType === 'sentence') {
    for (const chapter of document.chapters) {
      if (chapter.sentences.some((sentence) => sentence.id === anchorId)) {
        return { anchorId, anchorType, valid: true };
      }
    }
    return { anchorId, anchorType, valid: false };
  }
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      if (sentence.tokens.some((token) => token.id === anchorId)) {
        return { anchorId, anchorType: 'word', valid: true };
      }
      if (sentence.id === anchorId) {
        // 包里的词级锚点已因正文修订迁移到所属句
        return { anchorId, anchorType: 'sentence', valid: true, migratedWord: true };
      }
    }
  }
  return { anchorId, anchorType, valid: false };
}

function ruleKey(anchorId: string, kind: PackageAnnotation['kind']) {
  return `${anchorId}:${kind}`;
}

export function isPackageImported(document: TextDocument, packageId: string) {
  return document.importedPackages?.some((record) => record.packageId === packageId) ?? false;
}

function normalizeBody(body: string) {
  return body.trim();
}

/**
 * 按“锚点 + 注释类型 + 来源”试算合并计划，不改动文档：
 * - identical：同一锚点/类型/来源且正文未变，不新增记录；
 * - bothChanged：两边都改过 → 按来源并列收进冲突组，本地已解决的取舍原样保留；
 * - localResolvedKept：该锚点/类型的本地校记已结案，保留本地取舍；
 * - new：锚点上没有同来源记录，作为新条目加入。
 */
export function buildImportPlan(document: TextDocument, pkg: AnnotationPackage): ImportPlanItem[] {
  return pkg.annotations.map((incoming) => {
    const anchor = resolveAnchor(document, incoming);
    const base: Omit<ImportPlanItem, 'decision' | 'matchedLocal'> = {
      incoming,
      reason: '',
      effectiveAnchorId: anchor.anchorId,
      effectiveAnchorType: anchor.anchorType
    };

    if (!anchor.valid) {
      return {
        ...base,
        decision: 'skipped',
        reason: '锚点在当前正文中不存在，未导入，可先修订正文或在原包中校正锚点。'
      };
    }

    const key = ruleKey(anchor.anchorId, incoming.kind);
    const sameRule = document.annotations.filter(
      (item) => ruleKey(item.anchorId, item.kind) === key
    );
    const sameSource = sameRule.find((item) => item.source === incoming.source);

    if (sameSource) {
      if (normalizeBody(sameSource.body) === normalizeBody(incoming.body) && sameSource.title.trim() === incoming.title.trim()) {
        return {
          ...base,
          decision: 'identical',
          matchedLocal: sameSource,
          reason: '同一锚点、类型与来源且内容一致，重复导入不新增记录。'
        };
      }
      if (sameSource.status === 'resolved' || sameSource.conflictState === 'resolved') {
        return {
          ...base,
          decision: 'localResolvedKept',
          matchedLocal: sameSource,
          reason: '本地该来源校记已结案，保留本地取舍，导入版本仅存档不覆盖。'
        };
      }
      return {
        ...base,
        decision: 'bothChanged',
        matchedLocal: sameSource,
        reason: '本地与离线包都改过：按来源并列，供逐条查看后选用或合并。'
      };
    }

    if (sameRule.some((item) => item.status === 'resolved' || item.conflictState === 'resolved')) {
      const resolved = sameRule.find((item) => item.conflictState === 'resolved') ?? sameRule[0];
      return {
        ...base,
        decision: 'localResolvedKept',
        matchedLocal: resolved,
        reason: '该锚点/类型的冲突已按来源结案，新来源不覆盖既有取舍，仅登记待复核。'
      };
    }

    if (sameRule.some((item) => item.stale)) {
      return {
        ...base,
        decision: 'staleTarget',
        matchedLocal: sameRule.find((item) => item.stale),
        reason: '锚点相关批注因正文修订已失效，请先复核再纳入该来源。'
      };
    }

    return {
      ...base,
      decision: 'new',
      reason: anchor.migratedWord
        ? '词级锚点已随此前正文修订迁移到所属句，按句子锚点导入。'
        : '锚点上的新来源，加入后自动参与冲突汇总。'
    };
  });
}

function uniqueAnnotationId(document: TextDocument, preferred: string | undefined, packageId: string) {
  const existing = new Set(document.annotations.map((item) => item.id));
  if (preferred && !existing.has(preferred)) return preferred;
  let seed = preferred
    ? `${preferred}-${packageId}`
    : `annotation-pkg-${packageId}-${Date.now().toString(36)}`;
  seed = seed.replace(/[^a-zA-Z0-9_-]/g, '_');
  let id = seed;
  let counter = 2;
  while (existing.has(id)) {
    id = `${seed}-${counter}`;
    counter += 1;
  }
  return id;
}

/** 合并计划落地：新增/并列条目写入文档，引用 ID 映射到新记录，登记去重信息。 */
export function applyImportPlan(document: TextDocument, pkg: AnnotationPackage, plan: ImportPlanItem[]): ImportReport {
  const now = new Date().toISOString();
  // 同一包再导入：登记过即视为空操作，绝不新增记录
  if (isPackageImported(document, pkg.packageId)) {
    return {
      packageId: pkg.packageId,
      label: pkg.label,
      source: pkg.source,
      importedAt: now,
      added: [],
      identical: plan.filter((item) => item.decision !== 'skipped'),
      keptLocalResolved: [],
      skipped: plan.filter((item) => item.decision === 'skipped')
    };
  }
  const idMap = new Map<string, string>();
  const report: ImportReport = {
    packageId: pkg.packageId,
    label: pkg.label,
    source: pkg.source,
    importedAt: now,
    added: [],
    identical: [],
    keptLocalResolved: [],
    skipped: []
  };
  let kept = 0;
  let skippedCount = 0;

  for (const item of plan) {
    if (item.decision === 'skipped') {
      report.skipped.push(item);
      skippedCount += 1;
      continue;
    }
    if (item.decision === 'new' || item.decision === 'bothChanged' || item.decision === 'staleTarget') {
      const incoming = item.incoming;
      const id = uniqueAnnotationId(document, incoming.id, pkg.packageId);
      if (incoming.id) idMap.set(incoming.id, id);
      const annotation: Annotation = {
        id,
        anchorId: item.effectiveAnchorId,
        anchorType: item.effectiveAnchorType,
        kind: incoming.kind,
        title: incoming.title,
        body: incoming.body,
        source:
          item.decision === 'bothChanged'
            ? `${incoming.source}｜${pkg.label}`
            : incoming.source,
        references: incoming.references ?? [],
        status: 'open',
        tags: Array.from(new Set([...(incoming.tags ?? []), pkg.source])),
        conflictState: 'open',
        stale: item.decision === 'staleTarget',
        importedFrom: pkg.packageId,
        updatedAt: now
      };
      document.annotations.push(annotation);
      report.added.push(item);
    } else if (item.decision === 'identical') {
      if (item.incoming.id) idMap.set(item.incoming.id, item.matchedLocal!.id);
      report.identical.push(item);
    } else {
      if (item.incoming.id && item.matchedLocal) idMap.set(item.incoming.id, item.matchedLocal.id);
      report.keptLocalResolved.push(item);
      kept += 1;
    }
  }

  // 引用重写：包内 ID → 合并后实际 ID；指向本地已存在记录的引用原样保留
  const localIds = new Set(document.annotations.map((item) => item.id));
  for (const item of plan) {
    if (item.decision !== 'new' && item.decision !== 'bothChanged' && item.decision !== 'staleTarget') continue;
    const incoming = item.incoming;
    const mappedId = incoming.id ? idMap.get(incoming.id) : undefined;
    if (!mappedId) continue;
    const target = document.annotations.find((annotation) => annotation.id === mappedId);
    if (!target) continue;
    target.references = (incoming.references ?? []).map((ref) => idMap.get(ref) ?? ref).filter((ref) => localIds.has(ref));
  }

  const record: ImportedPackageRecord = {
    packageId: pkg.packageId,
    label: pkg.label,
    source: pkg.source,
    importedAt: now,
    added: report.added.length,
    keptLocalResolved: kept,
    skipped: report.identical.length + kept + skippedCount
  };
  document.importedPackages = [...(document.importedPackages ?? []), record];
  return report;
}

export function summarizePlan(plan: ImportPlanItem[]) {
  return {
    new: plan.filter((item) => item.decision === 'new').length,
    bothChanged: plan.filter((item) => item.decision === 'bothChanged').length,
    staleTarget: plan.filter((item) => item.decision === 'staleTarget').length,
    identical: plan.filter((item) => item.decision === 'identical').length,
    localResolvedKept: plan.filter((item) => item.decision === 'localResolvedKept').length,
    skipped: plan.filter((item) => item.decision === 'skipped').length
  };
}

export const importDecisionLabels: Record<ImportPlanItem['decision'], string> = {
  new: '新增来源',
  bothChanged: '两边都改过 · 按来源并列',
  identical: '内容一致 · 不新增',
  localResolvedKept: '本地已解决 · 保留取舍',
  staleTarget: '正文已改 · 失效待复核',
  skipped: '锚点无效 · 跳过'
};
