import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyPlus, Loader2, X } from "lucide-react";
import { Modal } from "../ui/Modal";
import { toErrorMessage } from "../../utils/errors";
import {
  defaultCloneTableName,
  getCloneTableNameError,
} from "../../utils/cloneTable";

interface CloneTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The table being cloned. */
  tableName: string;
  onSubmit: (newName: string, includeData: boolean) => Promise<void>;
}

type CloneTableFormProps = Omit<CloneTableModalProps, "isOpen">;

// The form only exists while the modal is open, so its state starts fresh on
// every open and needs no reset effect.
const CloneTableForm = ({ onClose, tableName, onSubmit }: CloneTableFormProps) => {
  const { t } = useTranslation();
  const titleId = useId();
  const nameId = useId();
  const dataId = useId();
  const errorId = useId();
  const [name, setName] = useState(defaultCloneTableName(tableName));
  const [includeData, setIncludeData] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);

  const nameError = getCloneTableNameError(name, tableName);
  const errorText =
    nameError === "empty"
      ? t("sidebar.cloneTableNameEmpty")
      : nameError === "same"
        ? t("sidebar.cloneTableNameSame")
        : "";
  const visibleError = serverError || (touched ? errorText : "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError || busy) return;
    setBusy(true);
    setServerError("");
    try {
      await onSubmit(name.trim(), includeData);
      onClose();
    } catch (err) {
      setServerError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="bg-elevated border border-strong rounded-xl shadow-2xl w-[600px] max-w-[90vw] max-h-[90vh] overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between p-4 border-b border-default bg-base">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent-secondary/15 rounded-lg">
            <CopyPlus size={20} className="text-accent-secondary" />
          </div>
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-primary">
              {t("sidebar.cloneTable")}
            </h2>
            <p className="text-xs text-secondary">
              {t("sidebar.cloneTableSubtitle", { table: tableName })}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label={t("common.cancel")}
          className="text-secondary hover:text-primary transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
        >
          <X size={20} />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col overflow-hidden">
        <div className="p-6 space-y-6 overflow-y-auto">
          <div>
            <label htmlFor={nameId} className="block text-xs uppercase font-bold text-muted mb-2">
              {t("sidebar.cloneTableName")}
            </label>
            <input
              id={nameId}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              type="text"
              autoFocus
              value={name}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value);
                setServerError("");
              }}
              onBlur={() => setTouched(true)}
              aria-invalid={visibleError ? true : undefined}
              aria-describedby={visibleError ? errorId : undefined}
              className="w-full px-3 py-2 bg-base border border-strong rounded-lg text-primary font-mono placeholder:text-muted focus:border-focus focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            />
            {visibleError && (
              <div id={errorId} role="alert" className="text-accent-error text-xs mt-2 break-words">
                {visibleError}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <input
                id={dataId}
                type="checkbox"
                checked={includeData}
                disabled={busy}
                onChange={(e) => setIncludeData(e.target.checked)}
                className="accent-accent-primary"
              />
              <label htmlFor={dataId} className="text-sm text-secondary select-none cursor-pointer">
                {t("sidebar.cloneTableIncludeData")}
              </label>
            </div>
            <p className="text-xs text-muted mt-1 ml-6">
              {t("sidebar.cloneTableIncludeDataHint")}
            </p>
          </div>

          <p className="text-xs text-muted">{t("sidebar.cloneTableNote")}</p>
        </div>

        <div className="p-4 border-t border-default bg-base/50 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-secondary hover:text-primary transition-colors text-sm rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 text-inverse rounded-lg text-sm font-medium disabled:opacity-50 transition-colors flex items-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? t("sidebar.cloneTableCloning") : t("sidebar.cloneTableAction")}
          </button>
        </div>
      </form>
    </div>
  );
};

export const CloneTableModal = ({ isOpen, ...props }: CloneTableModalProps) => (
  <Modal isOpen={isOpen} onClose={props.onClose}>
    <CloneTableForm key={props.tableName} {...props} />
  </Modal>
);
