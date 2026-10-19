import { describe, it, expect } from "vitest";
import {
  copyTargetConnections,
  defaultTargetDatabase,
  getCopyDatabaseError,
  savedDatabases,
} from "../../src/utils/copyDatabase";
import type { SavedConnection } from "../../src/contexts/DatabaseContext";

const connection = (
  id: string,
  driver: string,
  database: string | string[] = "",
): SavedConnection => ({ id, name: id, params: { driver, database } });

describe("copyTargetConnections", () => {
  const connections = [
    connection("prod", "mysql"),
    connection("local", "mysql"),
    connection("pg", "postgres"),
    // A plugin driver id is compared the same way as a built-in one.
    connection("duck-a", "duckdb"),
    connection("duck-b", "duckdb"),
  ];

  it("keeps connections that use the source's driver, the source included", () => {
    expect(copyTargetConnections(connections, "prod").map((c) => c.id)).toEqual([
      "prod",
      "local",
    ]);
    expect(copyTargetConnections(connections, "duck-a").map((c) => c.id)).toEqual([
      "duck-a",
      "duck-b",
    ]);
  });

  it("returns nothing for an unknown source", () => {
    expect(copyTargetConnections(connections, "missing")).toEqual([]);
  });
});

describe("savedDatabases", () => {
  it("normalises a single name or a list and drops blanks", () => {
    expect(savedDatabases(connection("a", "mysql", "shop"))).toEqual(["shop"]);
    expect(savedDatabases(connection("a", "mysql", ["shop", "", "crm"]))).toEqual([
      "shop",
      "crm",
    ]);
    expect(savedDatabases(connection("a", "mysql", ""))).toEqual([]);
  });
});

describe("defaultTargetDatabase", () => {
  it("skips the source database on the same connection", () => {
    expect(defaultTargetDatabase(["shop", "shop_test"], true, "shop")).toBe("shop_test");
    expect(defaultTargetDatabase(["shop"], true, "shop")).toBe("");
  });

  it("takes the first database on another connection", () => {
    expect(defaultTargetDatabase(["shop", "crm"], false, "shop")).toBe("shop");
    expect(defaultTargetDatabase([], false, "shop")).toBe("");
  });
});

describe("getCopyDatabaseError", () => {
  const base = {
    selectedTables: 2,
    sourceConnectionId: "prod",
    sourceDatabase: "shop",
    targetConnectionId: "local",
    targetDatabase: "shop",
  };

  it("accepts a copy to another connection or database", () => {
    expect(getCopyDatabaseError(base)).toBeNull();
    expect(
      getCopyDatabaseError({ ...base, targetConnectionId: "prod", targetDatabase: "shop_test" }),
    ).toBeNull();
  });

  it("explains what is missing", () => {
    expect(getCopyDatabaseError({ ...base, selectedTables: 0 })).toBe("noTables");
    expect(getCopyDatabaseError({ ...base, targetConnectionId: "" })).toBe("noTarget");
    expect(getCopyDatabaseError({ ...base, targetConnectionId: "prod" })).toBe("sameDatabase");
  });
});
