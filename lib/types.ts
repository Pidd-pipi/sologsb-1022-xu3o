export type ViewMode = 'reading' | 'editing' | 'critical';
export type AnchorType = 'chapter' | 'sentence' | 'word';
export type AnnotationKind = 'footnote' | 'variant' | 'background' | 'crossref';
export type AnnotationStatus = 'open' | 'resolved';

export interface TextToken {
  id: string;
  text: string;
}

export interface Sentence {
  id: string;
  order: number;
  text: string;
  tokens: TextToken[];
}

export interface Chapter {
  id: string;
  order: number;
  title: string;
  summary: string;
  sentences: Sentence[];
}

export interface Annotation {
  id: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  title: string;
  body: string;
  source: string;
  references: string[];
  status: AnnotationStatus;
  tags: string[];
  conflictState: 'open' | 'resolved';
  conflictResolution?: string;
  /** 正文修订后相关批注立即失效，等待人工复核 */
  stale?: boolean;
  /** 导入自哪个离线批注包 */
  importedFrom?: string;
  updatedAt: string;
}

export type PackageAnnotationKind = AnnotationKind;
export type PackageAnchorType = AnchorType;

export interface PackageAnnotation {
  id?: string;
  anchorId: string;
  anchorType: PackageAnchorType;
  kind: PackageAnnotationKind;
  title: string;
  body: string;
  source: string;
  references?: string[];
  tags?: string[];
}

export interface AnnotationPackage {
  packageId: string;
  label: string;
  source: string;
  exportedAt?: string;
  annotations: PackageAnnotation[];
}

export interface ImportedPackageRecord {
  packageId: string;
  label: string;
  source: string;
  importedAt: string;
  added: number;
  keptLocalResolved: number;
  skipped: number;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface TextDocument {
  id: string;
  title: string;
  author: string;
  edition: string;
  chapters: Chapter[];
  annotations: Annotation[];
  snapshots: VersionSnapshot[];
  /** 已成功合并的离线包登记，同一包重复导入直接去重 */
  importedPackages?: ImportedPackageRecord[];
  updatedAt: string;
}

export type ImportDecision =
  | 'identical'
  | 'new'
  | 'bothChanged'
  | 'localResolvedKept'
  | 'staleTarget'
  | 'skipped';

export interface ImportPlanItem {
  decision: ImportDecision;
  reason: string;
  incoming: PackageAnnotation;
  effectiveAnchorId: string;
  effectiveAnchorType: AnchorType;
  matchedLocal?: Annotation;
}

export interface ImportReport {
  packageId: string;
  label: string;
  source: string;
  importedAt: string;
  added: ImportPlanItem[];
  identical: ImportPlanItem[];
  keptLocalResolved: ImportPlanItem[];
  skipped: ImportPlanItem[];
}

export interface PendingImportBatch {
  batchId: string;
  packageId: string;
  label: string;
  source: string;
  raw: string;
  reason: string;
  failedAt: string;
}

export interface WorkspaceState {
  document: TextDocument;
  mode: ViewMode;
  selectedChapterId: string;
  selectedSentenceId: string;
  selectedAnnotationId: string | null;
  query: string;
  dirty: boolean;
}

export interface EditorState {
  workspace: WorkspaceState;
  past: WorkspaceState[];
  future: WorkspaceState[];
  lastAction: string;
}

export interface SearchResult {
  chapterId: string;
  sentenceId?: string;
  annotationId?: string;
  title: string;
  excerpt: string;
  kind: 'text' | 'annotation';
}

export interface ConflictGroup {
  key: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  anchorLabel: string;
  annotations: Annotation[];
}
