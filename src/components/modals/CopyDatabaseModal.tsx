import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, Database, Loader2, X } from "lucide-react";
import { Modal } from "../ui/Modal";
import type { SavedConnection, TableInfo } from "../../contexts/DatabaseContext";
import { toErrorMessage } from "../../utils/errors";
import { formatElapsedTime } from "../../utils/formatTime";
import {
  copyTargetConnections,
  defaultTargetDatabase,
  getCopyDatabaseError,
  savedDatabases,
} from "../../utils/copyDatabase";

interface CopyDatabaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Source connection. */
  connectionId: string;
  /** Name of the source database, shown and compared with the target. */
  databaseName: string;
  /** Database to scope the source to on multi-database connections. */
  database?: string;
  /** Schema of a schema-based driver; the copy keeps the same schema name. */
  schema?: string;
  /** Called after a successful copy with the target it went to. */
  onCopied?: (targetConnectionId: string, targetDatabase: string) => void;
}

interface CopyProgress {
  table: string;
  index: number;
  total: number;
}

type CopyFormProps = Omit<CopyDatabaseModalProps, "isOpen"> & {
  /** Receives the form's close handler, which refuses while a copy runs. */
  registerClose: (close: () => void) => void;
};

const fieldClass =
  "w-full px-3 py-2 bg-base border border-strong rounded-lg text-primary focus:border-focus focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const labelClass = "block text-xs uppercase font-bold text-muted mb-2";

// The form only exists while the modal is open, so its state starts fresh on
// every open.
const CopyDatabaseForm = ({
  onClose,
  connectionId,
  databaseName,
  database,
  schema,
  onCopied,
  registerClose,
}: CopyFormProps) => {
  const { t } = useTranslation();
  const titleId = useId();
  const targetConnectionId = useId();
  const targetDatabaseId = useId();
  const dropId = useId();

  const [tables, setTables] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [targetConnection, setTargetConnection] = useState("");
  const [targetDatabases, setTargetDatabases] = useState<string[] | null>(null);
  const [targetDatabase, setTargetDatabase] = useState("");
  const [includeData, setIncludeData] = useState(true);
  const [dropExisting, setDropExisting] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CopyProgress | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const scope = useMemo(
    () => ({
      ...(schema ? { schema } : {}),
      ...(database ? { database } : {}),
    }),
    [schema, database],
  );

  // Source tables, all selected by default.
  useEffect(() => {
    let active = true;
    invoke<TableInfo[]>("get_tables", { connectionId, ...scope })
      .then((list) => {
        if (!active) return;
        const names = list.map((table) => table.name);
        setTables(names);
        setSelected(new Set(names));
      })
      .catch((err) => {
        if (!active) return;
        setTables([]);
        setError(toErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [connectionId, scope]);

  // Saved connections the copy can go to; the source one is preselected.
  useEffect(() => {
    let active = true;
    invoke<SavedConnection[]>("get_connections")
      .then((list) => {
        if (!active) return;
        setConnections(list);
        setTargetConnection(connectionId);
      })
      .catch((err) => active && setError(toErrorMessage(err)));
    return () => {
      active = false;
    };
  }, [connectionId]);

  const targets = useMemo(
    () => copyTargetConnections(connections, connectionId),
    [connections, connectionId],
  );
  const sourceConnectionName =
    connections.find((c) => c.id === connectionId)?.name ?? "";

  // Databases of the chosen target, read from the server; falls back to the
  // ones saved on the connection when the server can't be listed.
  useEffect(() => {
    const target = targets.find((c) => c.id === targetConnection);
    if (!target) return;
    let active = true;
    const apply = (names: string[]) => {
      if (!active) return;
      setTargetDatabases(names);
      setTargetDatabase(
        defaultTargetDatabase(names, target.id === connectionId, databaseName),
      );
    };
    invoke<string[]>("list_databases", {
      request: { params: target.params, connection_id: target.id },
    })
      .then(apply)
      .catch(() => apply(savedDatabases(target)));
    return () => {
      active = false;
      setTargetDatabases(null);
    };
  }, [targets, targetConnection, connectionId, databaseName]);

  useEffect(() => {
    const unlisten = listen<CopyProgress>("copy_database_progress", (event) =>
      setProgress(event.payload),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const startedAtRef = useRef(startedAt);
  startedAtRef.current = startedAt;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (startedAtRef.current) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Escape must not close the dialog mid-copy: the copy would carry on with
  // nothing on screen to stop it.
  registerClose(() => {
    if (!running) onClose();
  });

  const blocker = getCopyDatabaseError({
    selectedTables: selected.size,
    sourceConnectionId: connectionId,
    sourceDatabase: databaseName,
    targetConnectionId: targetConnection,
    targetDatabase,
  });
  const allSelected = tables !== null && tables.length > 0 && selected.size === tables.length;
  const locked = running || copied;

  const toggleTable = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const handleCopy = async () => {
    if (blocker || running || tables === null) return;
    setRunning(true);
    setError("");
    setProgress(null);
    setStartedAt(Date.now());
    setElapsed(0);
    try {
      await invoke("copy_database", {
        sourceConnectionId: connectionId,
        ...(database ? { sourceDatabase: database } : {}),
        targetConnectionId: targetConnection,
        ...(targetDatabase ? { targetDatabase } : {}),
        ...(schema ? { schema } : {}),
        options: {
          // Keep the source order so the copy matches the explorer.
          tables: tables.filter((name) => selected.has(name)),
          structure: true,
          data: includeData,
          drop_existing: dropExisting,
        },
      });
      setCopied(true);
      onCopied?.(targetConnection, targetDatabase);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const handleStop = async () => {
    try {
      await invoke("cancel_copy_database", { sourceConnectionId: connectionId });
    } catch (err) {
      console.error("Failed to stop the copy:", err);
    }
  };

  const blockerText =
    blocker === "noTables"
      ? t("copyDatabase.errorNoTables")
      : blocker === "sameDatabase"
        ? t("copyDatabase.errorSameDatabase")
        : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="bg-elevated border border-strong rounded-xl shadow-2xl w-[600px] max-w-[90vw] max-h-[90vh] overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between p-4 border-b border-default bg-base">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 bg-accent-secondary/15 rounded-lg">
            <Database size={20} className="text-accent-secondary" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-primary">
              {t("copyDatabase.title")}
            </h2>
            <p className="text-xs text-secondary truncate">
              {t("copyDatabase.subtitle", {
                connection: sourceConnectionName,
                database: databaseName,
              })}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={running}
          aria-label={t("common.close")}
          className="text-secondary hover:text-primary transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
        >
          <X size={20} />
        </button>
      </div>

      <div className="p-6 space-y-6 overflow-y-auto">
        <fieldset disabled={locked} className="space-y-2">
          <div className="flex items-center justify-between">
            <legend className={labelClass + " mb-0"}>
              {t("copyDatabase.tables", {
                selected: selected.size,
                total: tables?.length ?? 0,
              })}
            </legend>
            <button
              type="button"
              onClick={() => setSelected(allSelected ? new Set() : new Set(tables ?? []))}
              disabled={!tables?.length}
              className="text-xs text-accent hover:underline rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
            >
              {allSelected ? t("dump.deselectAll") : t("dump.selectAll")}
            </button>
          </div>
          <div className="border border-default rounded-lg max-h-48 overflow-y-auto p-2 grid grid-cols-2 gap-1">
            {tables === null ? (
              <div className="col-span-2 flex justify-center p-4 text-muted">
                <Loader2 size={16} className="animate-spin" aria-label={t("copyDatabase.loading")} />
              </div>
            ) : (
              tables.map((name) => (
                <label
                  key={name}
                  className="flex items-center gap-2 p-1.5 rounded hover:bg-surface-secondary cursor-pointer min-w-0"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(name)}
                    onChange={() => toggleTable(name)}
                    className="accent-accent-primary"
                  />
                  <span className="text-sm font-mono text-secondary truncate" title={name}>
                    {name}
                  </span>
                </label>
              ))
            )}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={targetConnectionId} className={labelClass}>
              {t("copyDatabase.targetConnection")}
            </label>
            <select
              id={targetConnectionId}
              value={targetConnection}
              disabled={locked}
              onChange={(e) => setTargetConnection(e.target.value)}
              className={fieldClass}
            >
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={targetDatabaseId} className={labelClass}>
              {t("copyDatabase.targetDatabase")}
            </label>
            {targetDatabases && targetDatabases.length > 0 ? (
              <select
                id={targetDatabaseId}
                value={targetDatabase}
                disabled={locked}
                onChange={(e) => setTargetDatabase(e.target.value)}
                className={fieldClass + " font-mono"}
              >
                {targetDatabase === "" && <option value="" />}
                {targetDatabases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={targetDatabaseId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={targetDatabase}
                disabled={locked || targetDatabases === null}
                onChange={(e) => setTargetDatabase(e.target.value)}
                className={fieldClass + " font-mono"}
              />
            )}
          </div>
        </div>

        <fieldset disabled={locked} className="space-y-2">
          <legend className={labelClass}>{t("copyDatabase.whatToCopy")}</legend>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
              <input
                type="radio"
                name="copy-content"
                checked={includeData}
                onChange={() => setIncludeData(true)}
                className="accent-accent-primary"
              />
              {t("copyDatabase.structureAndData")}
            </label>
            <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
              <input
                type="radio"
                name="copy-content"
                checked={!includeData}
                onChange={() => setIncludeData(false)}
                className="accent-accent-primary"
              />
              {t("copyDatabase.structureOnly")}
            </label>
          </div>
          <div className="flex items-start gap-2 pt-2">
            <input
              id={dropId}
              type="checkbox"
              checked={dropExisting}
              onChange={(e) => setDropExisting(e.target.checked)}
              className="accent-accent-primary mt-0.5"
            />
            <label htmlFor={dropId} className="text-sm text-secondary cursor-pointer">
              {t("copyDatabase.dropExisting")}
              {dropExisting && (
                <span className="block text-xs text-accent-warning mt-1">
                  {t("copyDatabase.dropExistingWarning")}
                </span>
              )}
            </label>
          </div>
        </fieldset>

        <p className="text-xs text-muted">{t("copyDatabase.note")}</p>

        {running && (
          <div className="flex items-center gap-2 text-sm text-secondary" aria-live="polite">
            <Loader2 size={16} className="animate-spin shrink-0" />
            <span className="truncate">
              {progress
                ? t("copyDatabase.progress", {
                    table: progress.table,
                    current: progress.index + 1,
                    total: progress.total,
                  })
                : t("copyDatabase.starting")}
            </span>
            {elapsed > 0 && (
              <span className="ml-auto font-mono text-muted">{formatElapsedTime(elapsed)}</span>
            )}
          </div>
        )}

        {copied && (
          <div className="flex items-center gap-2 text-sm text-accent-success" role="status">
            <CheckCircle2 size={16} className="shrink-0" />
            {t("copyDatabase.success")}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="text-xs text-accent-error bg-accent-error/10 border border-accent-error/25 rounded-lg p-3 break-words whitespace-pre-wrap max-h-40 overflow-y-auto"
          >
            {error}
          </div>
        )}
      </div>

      <div className="p-4 border-t border-default bg-base/50 flex items-center justify-end gap-3">
        {!locked && blockerText && (
          <span className="text-xs text-muted mr-auto">{blockerText}</span>
        )}
        {running ? (
          <button
            type="button"
            onClick={handleStop}
            className="px-4 py-2 bg-accent-error hover:bg-accent-error/90 text-on-accent-error rounded-lg text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {t("editor.stop")}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-secondary hover:text-primary transition-colors text-sm rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              {copied ? t("common.close") : t("common.cancel")}
            </button>
            {!copied && (
              <button
                type="button"
                onClick={handleCopy}
                disabled={blocker !== null || tables === null}
                className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 text-inverse rounded-lg text-sm font-medium disabled:opacity-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                {t("copyDatabase.copy")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export const CopyDatabaseModal = ({ isOpen, onClose, ...props }: CopyDatabaseModalProps) => {
  const closeRef = useRef(onClose);
  return (
    <Modal isOpen={isOpen} onClose={() => closeRef.current()}>
      <CopyDatabaseForm
        key={`${props.connectionId}:${props.databaseName}`}
        onClose={onClose}
        registerClose={(close) => {
          closeRef.current = close;
        }}
        {...props}
      />
    </Modal>
  );
};
