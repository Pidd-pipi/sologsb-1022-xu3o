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
  updatedAt: string;
  /** 引用目标是否已失效（句子正文修订后，原词级引用迁移到所属句并标记失效）。 */
  invalid?: boolean;
  invalidReason?: string;
  /** 跨离线包导入时的稳定身份：`${packageId}:${annotationId}`，用于幂等同一条目。 */
  originId?: string;
  /** 该条目由哪个离线批注包导入，用于按来源列出与追溯。 */
  importedFrom?: { packageId: string; label: string };
}

export interface VersionSnapshot {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

/** 离线批注包：整理组离线批注后带回合并的一批注释。 */
export interface AnnotationPackage {
  /** 包的稳定身份；重复导入同一 packageId 不新增记录。 */
  packageId: string;
  label: string;
  exportedAt: string;
  note?: string;
  /** 导出时的句子正文快照，用于检测句子正文是否被本地修订。 */
  sentences?: { id: string; text: string }[];
  annotations: Annotation[];
}

export interface PackageImportRecord {
  packageId: string;
  label: string;
  importedAt: string;
  annotationCount: number;
}

export interface TextDocument {
  id: string;
  title: string;
  author: string;
  edition: string;
  chapters: Chapter[];
  annotations: Annotation[];
  snapshots: VersionSnapshot[];
  importedPackages: PackageImportRecord[];
  updatedAt: string;
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
