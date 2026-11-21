import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb, type DB } from "./db";
import { ClapEmbedder, type Embedder } from "./embed";
import type { Filters, IndexProgress, SearchResult } from "./types";

export interface EngineOptions {
  dbPath: string;
  modelCacheDir?: string;
  embedder?: Embedder; // inject a fake one in tests
}

/** Single entry point used by both the CLI and the desktop app. */
export class Engine {
  private constructor(readonly db: DB, readonly embedder: Embedder) {}

  static async open(opts: EngineOptions): Promise<Engine> {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    const db = openDb(opts.dbPath);
    const embedder = opts.embedder ?? (await ClapEmbedder.load({ cacheDir: opts.modelCacheDir }));
    return new Engine(db, embedder);
  }

  addRoot(path: string): string {
    const abs = resolve(path);
    this.db.prepare("INSERT OR IGNORE INTO roots (path) VALUES (?)").run(abs);
    return abs;
  }

  /**
   * Forget a root and drop its indexed samples (except ones still covered by
   * another root, e.g. when roots are nested). Returns false if it wasn't a root.
   */
  removeRoot(path: string): boolean {
    const abs = resolve(path);
    return this.db.transaction(() => {
      const { changes } = this.db.prepare("DELETE FROM roots WHERE path = ?").run(abs);
      if (changes === 0) return false;
      this.db
        .prepare(
          `DELETE FROM samples
           WHERE substr(path, 1, length(@root) + 1) = @root || '/'
             AND NOT EXISTS (
               SELECT 1 FROM roots r
               WHERE substr(samples.path, 1, length(r.path) + 1) = r.path || '/'
             )`,
        )
        .run({ root: abs });
      return true;
    })();
  }

  roots(): string[] {
    return this.db.prepare("SELECT path FROM roots").pluck().all() as string[];
  }

  /**
   * TODO: scan roots for audio files, skip unchanged ones (mtime),
   * decode → embed → (BPM/key?) → store. Report progress as you go.
   */
  async index(onProgress?: (p: IndexProgress) => void): Promise<void> {
    onProgress?.({ done: 0, total: 0 });
  }

  /**
   * TODO: embed the query text, then nearest-neighbour search, e.g.
   *   SELECT ..., vec_distance_cosine(embedding, ?) AS d FROM samples ORDER BY d LIMIT ?
   */
  async search(query: string, filters: Filters = {}, k = 50): Promise<SearchResult[]> {
    return [];
  }

  /** TODO: same as search(), but start from an audio file's embedding (indexed or not). */
  async similar(path: string, filters: Filters = {}, k = 50): Promise<SearchResult[]> {
    return [];
  }

  close() {
    this.db.close();
  }
}
