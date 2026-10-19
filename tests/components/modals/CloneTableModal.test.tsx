import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CloneTableModal } from "../../../src/components/modals/CloneTableModal";

const translateMock = vi.hoisted(
  () => (key: string, options?: Record<string, unknown>) =>
    options?.table ? `${key}:${String(options.table)}` : key,
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translateMock }),
}));

vi.mock("../../../src/components/ui/Modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

describe("CloneTableModal", () => {
  const onClose = vi.fn();
  const onSubmit = vi.fn<(name: string, includeData: boolean) => Promise<void>>();

  const renderModal = () =>
    render(
      <CloneTableModal isOpen onClose={onClose} tableName="users" onSubmit={onSubmit} />,
    );

  const nameInput = () => screen.getByRole("textbox") as HTMLInputElement;
  const submit = () =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "sidebar.cloneTableAction" }));
    });

  beforeEach(() => {
    vi.clearAllMocks();
    onSubmit.mockResolvedValue(undefined);
  });

  it("suggests <table>_copy and shows the source table", () => {
    renderModal();
    expect(nameInput().value).toBe("users_copy");
    expect(screen.getByText("sidebar.cloneTableSubtitle:users")).toBeTruthy();
  });

  it("copies the structure only by default", async () => {
    renderModal();
    await submit();
    expect(onSubmit).toHaveBeenCalledWith("users_copy", false);
    expect(onClose).toHaveBeenCalled();
  });

  it("passes the trimmed name and the include-data choice", async () => {
    renderModal();
    fireEvent.change(nameInput(), { target: { value: "  users_backup " } });
    fireEvent.click(screen.getByRole("checkbox"));
    await submit();
    expect(onSubmit).toHaveBeenCalledWith("users_backup", true);
  });

  it("blocks an empty name or the source name", async () => {
    renderModal();
    fireEvent.change(nameInput(), { target: { value: " " } });
    await submit();
    expect(screen.getByRole("alert").textContent).toBe("sidebar.cloneTableNameEmpty");

    fireEvent.change(nameInput(), { target: { value: "users" } });
    await submit();
    expect(screen.getByRole("alert").textContent).toBe("sidebar.cloneTableNameSame");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the database error when cloning fails", async () => {
    onSubmit.mockRejectedValue("Table 'users_copy' already exists");
    renderModal();
    await submit();
    expect(screen.getByRole("alert").textContent).toBe("Table 'users_copy' already exists");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says what a clone does not copy", () => {
    renderModal();
    expect(screen.getByText("sidebar.cloneTableNote")).toBeTruthy();
  });
});
