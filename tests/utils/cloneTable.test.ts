import { describe, it, expect, vi } from "vitest";
import {
  defaultCloneTableName,
  getCloneTableNameError,
  runCloneTableStatements,
} from "../../src/utils/cloneTable";

describe("defaultCloneTableName", () => {
  it("appends _copy to the source name", () => {
    expect(defaultCloneTableName("users")).toBe("users_copy");
  });
});

describe("getCloneTableNameError", () => {
  it("flags blank names", () => {
    expect(getCloneTableNameError("", "users")).toBe("empty");
    expect(getCloneTableNameError("   ", "users")).toBe("empty");
  });

  it("flags the source name itself", () => {
    expect(getCloneTableNameError("users", "users")).toBe("same");
    expect(getCloneTableNameError(" users ", "users")).toBe("same");
  });

  it("accepts any other name", () => {
    expect(getCloneTableNameError("users_copy", "users")).toBeNull();
  });
});

describe("runCloneTableStatements", () => {
  it("runs every statement in order", async () => {
    const executed: string[] = [];
    const drop = vi.fn();
    await runCloneTableStatements(
      ["CREATE", "INSERT", "INDEX"],
      async (sql) => {
        executed.push(sql);
      },
      drop,
    );
    expect(executed).toEqual(["CREATE", "INSERT", "INDEX"]);
    expect(drop).not.toHaveBeenCalled();
  });

  it("does not drop anything when creating the table fails", async () => {
    const drop = vi.fn();
    await expect(
      runCloneTableStatements(
        ["CREATE", "INSERT"],
        async () => {
          throw new Error("table exists");
        },
        drop,
      ),
    ).rejects.toThrow("table exists");
    expect(drop).not.toHaveBeenCalled();
  });

  it("drops the new table and rethrows when a later statement fails", async () => {
    const drop = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async (sql: string) => {
      if (sql === "INSERT") throw new Error("copy failed");
    });
    await expect(
      runCloneTableStatements(["CREATE", "INSERT", "INDEX"], execute, drop),
    ).rejects.toThrow("copy failed");
    expect(drop).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalledWith("INDEX");
  });

  it("keeps the original error when the cleanup also fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runCloneTableStatements(
        ["CREATE", "INSERT"],
        async (sql) => {
          if (sql === "INSERT") throw new Error("copy failed");
        },
        async () => {
          throw new Error("drop failed");
        },
      ),
    ).rejects.toThrow("copy failed");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
