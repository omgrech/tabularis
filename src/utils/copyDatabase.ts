import type { SavedConnection } from "../contexts/DatabaseContext";

/**
 * Connections a copy from `sourceConnectionId` can go to: those using the
 * same driver, since copying between database types is not supported. The
 * source connection itself is included (another database on the same server).
 */
export function copyTargetConnections(
  connections: SavedConnection[],
  sourceConnectionId: string,
): SavedConnection[] {
  const source = connections.find((c) => c.id === sourceConnectionId);
  if (!source) return [];
  return connections.filter((c) => c.params.driver === source.params.driver);
}

/** The databases saved on a connection, as a list without blanks. */
export function savedDatabases(connection: SavedConnection): string[] {
  const { database } = connection.params;
  return (Array.isArray(database) ? database : [database]).filter(
    (name) => name !== "",
  );
}

/**
 * The target database to preselect: on the source connection, the first
 * database other than the source; elsewhere, the first one listed.
 */
export function defaultTargetDatabase(
  databases: string[],
  sameConnection: boolean,
  sourceDatabase: string,
): string {
  if (!sameConnection) return databases[0] ?? "";
  return databases.find((name) => name !== sourceDatabase) ?? "";
}

export type CopyDatabaseError = "noTables" | "noTarget" | "sameDatabase";

/** Why the Copy button is disabled, or `null` when the copy can start. */
export function getCopyDatabaseError(options: {
  selectedTables: number;
  sourceConnectionId: string;
  sourceDatabase: string;
  targetConnectionId: string;
  targetDatabase: string;
}): CopyDatabaseError | null {
  if (options.selectedTables === 0) return "noTables";
  if (options.targetConnectionId === "") return "noTarget";
  if (
    options.targetConnectionId === options.sourceConnectionId &&
    options.targetDatabase === options.sourceDatabase
  ) {
    return "sameDatabase";
  }
  return null;
}
