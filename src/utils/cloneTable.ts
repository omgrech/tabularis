/** Suggested name for a clone of `table`. */
export function defaultCloneTableName(table: string): string {
  return `${table}_copy`;
}

export type CloneTableNameError = "empty" | "same";

export function getCloneTableNameError(
  name: string,
  source: string,
): CloneTableNameError | null {
  if (name.trim() === "") return "empty";
  if (name.trim() === source) return "same";
  return null;
}

/**
 * Runs the statements built by `get_clone_table_sql` in order. The first
 * statement creates the new table; if a later one fails (e.g. copying the
 * rows), `dropNewTable` removes the half-made copy before the original
 * error is rethrown. A failed cleanup is reported to the console only, so
 * the user still sees why the clone itself failed.
 */
export async function runCloneTableStatements(
  statements: string[],
  execute: (sql: string) => Promise<unknown>,
  dropNewTable: () => Promise<unknown>,
): Promise<void> {
  for (const [index, sql] of statements.entries()) {
    try {
      await execute(sql);
    } catch (error) {
      if (index > 0) {
        try {
          await dropNewTable();
        } catch (cleanupError) {
          console.error("Failed to remove the partially cloned table:", cleanupError);
        }
      }
      throw error;
    }
  }
}
