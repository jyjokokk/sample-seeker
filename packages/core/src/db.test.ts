import { describe, expect, it } from "vitest";
import { fromBlob, openDb, toBlob } from "./db";

describe("toBlob / fromBlob", () => {
  it("round-trips a Float32Array", () => {
    const v = new Float32Array([0, 1.5, -2.25, 1e-7]);
    expect(fromBlob(toBlob(v))).toEqual(v);
  });

  it("only serialises the view, not the whole underlying buffer", () => {
    const backing = new Float32Array([9, 1, 2, 3, 9]);
    const view = backing.subarray(1, 4);
    const blob = toBlob(view);
    expect(blob.byteLength).toBe(3 * 4);
    expect(fromBlob(blob)).toEqual(new Float32Array([1, 2, 3]));
  });
});

describe("openDb", () => {
  it("creates the schema", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual(expect.arrayContaining(["roots", "samples"]));
    db.close();
  });

  it("loads sqlite-vec", () => {
    const db = openDb(":memory:");
    const version = db.prepare("SELECT vec_version()").pluck().get();
    expect(version).toMatch(/^v\d/);
    db.close();
  });
});
