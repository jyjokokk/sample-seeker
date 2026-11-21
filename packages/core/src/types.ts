export type Kind = "one_shot" | "loop";

export interface Sample {
  id: number;
  path: string;
  name: string;
  bpm: number | null;
  camelot: string | null; // e.g. "8A"
  kind: Kind | null;
}

export interface SearchResult extends Sample {
  score: number;
}

export interface Filters {
  bpm?: number;
  camelot?: string;
  kind?: Kind;
}

export interface IndexProgress {
  done: number;
  total: number;
  current?: string;
}
