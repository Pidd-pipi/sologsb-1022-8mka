import type {
  AnchorType,
  Annotation,
  Chapter,
  Sentence,
  TextDocument,
  VersionSnapshot
} from './types';

/** 版本比较时只需要章节与注释，当前草稿和快照都能满足 */
export interface VersionLike {
  id: string;
  label: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export type AnnotationFieldKey = 'title' | 'body' | 'source' | 'references' | 'status';

export interface AnnotationFieldChange {
  field: AnnotationFieldKey;
  label: string;
  before: string;
  after: string;
}

export type AnnotationChangeKind = 'added' | 'modified' | 'removed';

export interface AnnotationChange {
  kind: AnnotationChangeKind;
  id: string;
  before?: Annotation;
  after?: Annotation;
  /** 新增/改动取右侧目标，移除取左侧目标；无法定位时为 null */
  location: AnnotationLocation | null;
  fields: AnnotationFieldChange[];
}

export interface AnnotationLocation {
  chapterId: string;
  chapterTitle: string;
  sentenceId: string | null;
  sentenceOrder: number | null;
  sentenceText: string | null;
  anchorId: string;
  anchorType: AnchorType;
  wordText: string | null;
  /** 章节/句子/词语目标的人类可读描述 */
  label: string;
}

export interface SentenceChange {
  id: string;
  kind: 'added' | 'modified' | 'removed';
  chapterId: string;
  chapterTitle: string;
  sentenceOrder: number;
  beforeText: string;
  afterText: string;
}

export interface VersionComparison {
  left: VersionLike;
  right: VersionLike;
  sentenceChanges: SentenceChange[];
  annotationAdded: AnnotationChange[];
  annotationModified: AnnotationChange[];
  annotationRemoved: AnnotationChange[];
}

export const annotationFieldLabels: Record<AnnotationFieldKey, string> = {
  title: '标题',
  body: '正文',
  source: '来源',
  references: '引用关系',
  status: '处理状态'
};

export function getStatusText(annotation: Annotation): string {
  return annotation.status === 'resolved' || annotation.conflictState === 'resolved'
    ? '已解决'
    : '待处理';
}

function formatFieldValue(field: AnnotationFieldKey, annotation: Annotation): string {
  switch (field) {
    case 'title':
      return annotation.title;
    case 'body':
      return annotation.body;
    case 'source':
      return annotation.source || '未署名';
    case 'references':
      return annotation.references.length ? annotation.references.join('、') : '无引用';
    case 'status':
      return getStatusText(annotation);
  }
}

function referencesEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const other = new Set(right);
  return left.every((id) => other.has(id));
}

const COMPARE_FIELDS: AnnotationFieldKey[] = ['title', 'body', 'source', 'references', 'status'];

function diffAnnotation(before: Annotation, after: Annotation): AnnotationFieldChange[] {
  const changes: AnnotationFieldChange[] = [];
  for (const field of COMPARE_FIELDS) {
    const equal =
      field === 'references'
        ? referencesEqual(before.references, after.references)
        : formatFieldValue(field, before) === formatFieldValue(field, after);
    if (equal) continue;
    changes.push({
      field,
      label: annotationFieldLabels[field],
      before: formatFieldValue(field, before),
      after: formatFieldValue(field, after)
    });
  }
  return changes;
}

interface SentenceIndexEntry {
  chapter: Chapter;
  sentence: Sentence;
}

function indexSentences(version: VersionLike): Map<string, SentenceIndexEntry> {
  const map = new Map<string, SentenceIndexEntry>();
  for (const chapter of version.chapters) {
    for (const sentence of chapter.sentences) {
      map.set(sentence.id, { chapter, sentence });
    }
  }
  return map;
}

/** 在指定版本里定位注释目标；旧快照或迁移后的引用找不到时返回 null */
export function locateAnnotation(version: VersionLike, annotation: Annotation): AnnotationLocation | null {
  if (annotation.anchorType === 'chapter') {
    const chapter = version.chapters.find((item) => item.id === annotation.anchorId);
    if (!chapter) return null;
    return {
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      sentenceId: null,
      sentenceOrder: null,
      sentenceText: null,
      anchorId: chapter.id,
      anchorType: 'chapter',
      wordText: null,
      label: `章节 · ${chapter.title}`
    };
  }

  for (const chapter of version.chapters) {
    const sentence = chapter.sentences.find((item) => item.id === annotation.anchorId);
    if (sentence) {
      return {
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        sentenceId: sentence.id,
        sentenceOrder: sentence.order,
        sentenceText: sentence.text,
        anchorId: sentence.id,
        anchorType: 'sentence',
        wordText: null,
        label: `${chapter.title} · 第 ${sentence.order} 句`
      };
    }
    for (const owner of chapter.sentences) {
      const token = owner.tokens.find((item) => item.id === annotation.anchorId);
      if (token) {
        return {
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          sentenceId: owner.id,
          sentenceOrder: owner.order,
          sentenceText: owner.text,
          anchorId: token.id,
          anchorType: 'word',
          wordText: token.text.trim(),
          label: `${chapter.title} · 第 ${owner.order} 句 · “${token.text.trim()}”`
        };
      }
    }
  }
  return null;
}

export function compareVersions(left: VersionLike, right: VersionLike): VersionComparison {
  const leftSentences = indexSentences(left);
  const rightSentences = indexSentences(right);

  const sentenceChanges: SentenceChange[] = [];
  for (const [id, entry] of rightSentences) {
    const previous = leftSentences.get(id);
    if (!previous) {
      sentenceChanges.push({
        id,
        kind: 'added',
        chapterId: entry.chapter.id,
        chapterTitle: entry.chapter.title,
        sentenceOrder: entry.sentence.order,
        beforeText: '',
        afterText: entry.sentence.text
      });
    } else if (previous.sentence.text !== entry.sentence.text) {
      sentenceChanges.push({
        id,
        kind: 'modified',
        chapterId: entry.chapter.id,
        chapterTitle: entry.chapter.title,
        sentenceOrder: entry.sentence.order,
        beforeText: previous.sentence.text,
        afterText: entry.sentence.text
      });
    }
  }
  for (const [id, entry] of leftSentences) {
    if (!rightSentences.has(id)) {
      sentenceChanges.push({
        id,
        kind: 'removed',
        chapterId: entry.chapter.id,
        chapterTitle: entry.chapter.title,
        sentenceOrder: entry.sentence.order,
        beforeText: entry.sentence.text,
        afterText: ''
      });
    }
  }
  sentenceChanges.sort(
    (a, b) => a.chapterId.localeCompare(b.chapterId) || a.sentenceOrder - b.sentenceOrder || a.kind.localeCompare(b.kind)
  );

  const leftMap = new Map(left.annotations.map((item) => [item.id, item]));
  const rightMap = new Map(right.annotations.map((item) => [item.id, item]));

  const annotationAdded: AnnotationChange[] = [];
  const annotationModified: AnnotationChange[] = [];
  const annotationRemoved: AnnotationChange[] = [];

  for (const annotation of right.annotations) {
    const previous = leftMap.get(annotation.id);
    if (!previous) {
      annotationAdded.push({
        kind: 'added',
        id: annotation.id,
        after: annotation,
        location: locateAnnotation(right, annotation),
        fields: []
      });
      continue;
    }
    const fields = diffAnnotation(previous, annotation);
    if (fields.length) {
      annotationModified.push({
        kind: 'modified',
        id: annotation.id,
        before: previous,
        after: annotation,
        location: locateAnnotation(right, annotation),
        fields
      });
    }
  }

  for (const annotation of left.annotations) {
    if (rightMap.has(annotation.id)) continue;
    annotationRemoved.push({
      kind: 'removed',
      id: annotation.id,
      before: annotation,
      location: locateAnnotation(left, annotation),
      fields: []
    });
  }

  return {
    left,
    right,
    sentenceChanges,
    annotationAdded,
    annotationModified,
    annotationRemoved
  };
}

export function snapshotAsVersion(snapshot: VersionSnapshot): VersionLike {
  return { id: snapshot.id, label: snapshot.label, chapters: snapshot.chapters, annotations: snapshot.annotations };
}

export function currentDocumentAsVersion(document: TextDocument): VersionLike {
  return {
    id: 'current',
    label: '当前草稿',
    chapters: document.chapters,
    annotations: document.annotations
  };
}
