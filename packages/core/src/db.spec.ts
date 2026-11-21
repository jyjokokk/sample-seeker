import { describe, expect, it } from "vitest";
import { fromBlob, openDb, toBlob } from "./db";

describe("embedding BLOB helpers", () => {
  it("restores an embedding exactly after a round-trip through a BLOB", () => {
    const embedding = new Float32Array([0, 1.5, -2.25, 1e-7]);

    expect(fromBlob(toBlob(embedding))).toEqual(embedding);
  });

  it("stores only the values in view when the embedding is a slice of a larger buffer", () => {
    const backing = new Float32Array([9, 1, 2, 3, 9]);
    const embedding = backing.subarray(1, 4);

    const blob = toBlob(embedding);

    expect(blob.byteLength).toBe(3 * Float32Array.BYTES_PER_ELEMENT);
    expect(fromBlob(blob)).toEqual(new Float32Array([1, 2, 3]));
  });
});

describe("openDb", () => {
  it("creates the roots and samples tables in a new database", () => {
    const db = openDb(":memory:");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();

    expect(tables).toEqual(expect.arrayContaining(["roots", "samples"]));
    db.close();
  });

  it("loads the sqlite-vec extension so vector functions can be used in queries", () => {
    const db = openDb(":memory:");

    const version = db.prepare("SELECT vec_version()").pluck().get();

    expect(version).toMatch(/^v\d/);
    db.close();
  });
});
