import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CopyDatabaseModal } from "../../../src/components/modals/CopyDatabaseModal";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../../src/components/ui/Modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

const invokeMock = vi.mocked(invoke);

const connections = [
  { id: "prod", name: "Production", params: { driver: "mysql", database: "" } },
  { id: "local", name: "Local", params: { driver: "mysql", database: ["dev", "scratch"] } },
  { id: "pg", name: "Postgres", params: { driver: "postgres", database: "app" } },
];

type Handler = (args: Record<string, unknown>) => unknown;

function mockCommands(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    get_tables: () => [{ name: "customers" }, { name: "orders" }, { name: "logs" }],
    get_connections: () => connections,
    list_databases: (args) => {
      const request = args.request as { connection_id: string };
      return request.connection_id === "prod" ? ["shop", "shop_test"] : ["dev"];
    },
    copy_database: () => undefined,
    ...overrides,
  };
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler((args ?? {}) as Record<string, unknown>);
  });
}

const onClose = vi.fn();
const onCopied = vi.fn();

const renderModal = () =>
  render(
    <CopyDatabaseModal
      isOpen
      onClose={onClose}
      connectionId="prod"
      databaseName="shop"
      database="shop"
      onCopied={onCopied}
    />,
  );

const copyButton = () => screen.getByRole("button", { name: "copyDatabase.copy" });

async function ready() {
  await screen.findByText("customers");
  await waitFor(() =>
    expect((screen.getByLabelText("copyDatabase.targetDatabase") as HTMLSelectElement).value).toBe(
      "shop_test",
    ),
  );
}

describe("CopyDatabaseModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommands();
  });

  it("selects every source table and offers only connections of the same type", async () => {
    renderModal();
    await ready();

    for (const name of ["customers", "orders", "logs"]) {
      expect((screen.getByRole("checkbox", { name }) as HTMLInputElement).checked).toBe(true);
    }
    const targets = screen.getByLabelText("copyDatabase.targetConnection") as HTMLSelectElement;
    expect(Array.from(targets.options).map((o) => o.value)).toEqual(["prod", "local"]);
    expect(targets.value).toBe("prod");
  });

  it("will not copy a database onto itself", async () => {
    renderModal();
    await ready();

    fireEvent.change(screen.getByLabelText("copyDatabase.targetDatabase"), {
      target: { value: "shop" },
    });
    expect(copyButton()).toBeDisabled();
    expect(screen.getByText("copyDatabase.errorSameDatabase")).toBeTruthy();
  });

  it("sends the selected tables, target and options", async () => {
    renderModal();
    await ready();

    fireEvent.click(screen.getByRole("checkbox", { name: "orders" }));
    fireEvent.click(screen.getByRole("radio", { name: "copyDatabase.structureOnly" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /copyDatabase.dropExisting/ }));
    await act(async () => {
      fireEvent.click(copyButton());
    });

    expect(invokeMock).toHaveBeenCalledWith("copy_database", {
      sourceConnectionId: "prod",
      sourceDatabase: "shop",
      targetConnectionId: "prod",
      targetDatabase: "shop_test",
      options: {
        tables: ["customers", "logs"],
        structure: true,
        data: false,
        drop_existing: true,
      },
    });
    expect(await screen.findByText("copyDatabase.success")).toBeTruthy();
    expect(onCopied).toHaveBeenCalledWith("prod", "shop_test");
  });

  it("falls back to the saved databases when the target server can't be listed", async () => {
    mockCommands({
      list_databases: (args) => {
        const request = args.request as { connection_id: string };
        if (request.connection_id === "local") throw new Error("offline");
        return ["shop", "shop_test"];
      },
    });
    renderModal();
    await ready();

    fireEvent.change(screen.getByLabelText("copyDatabase.targetConnection"), {
      target: { value: "local" },
    });
    await waitFor(() => {
      const select = screen.getByLabelText("copyDatabase.targetDatabase") as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(["dev", "scratch"]);
      expect(select.value).toBe("dev");
    });
  });

  it("keeps the dialog open and shows the error when the copy fails", async () => {
    mockCommands({
      copy_database: () => {
        throw "These tables already exist in the target: customers.";
      },
    });
    renderModal();
    await ready();

    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect((await screen.findByRole("alert")).textContent).toContain("already exist");
    expect(onCopied).not.toHaveBeenCalled();
    expect(copyButton()).not.toBeDisabled();
  });
});
