//! Pure SQL builders for the explorer's "Clone table" action.

use super::helpers::escape_identifier;

/// Statements for the explorer's "Clone table" action. `LIKE ... INCLUDING
/// ALL` copies columns, defaults, constraints except foreign keys, indexes,
/// identity and comments. Rows are inserted with `OVERRIDING SYSTEM VALUE`
/// so `GENERATED ALWAYS` identity values are kept, then each of the new
/// table's own sequences is moved past the copied rows. A serial column's
/// copied default still points at the source table's sequence, for which
/// `pg_get_serial_sequence` returns NULL and the `setval` is a no-op.
/// `sequence_columns` are the auto-increment columns among `data_columns`.
pub(super) fn clone_table_statements(
    schema: &str,
    source: &str,
    target: &str,
    data_columns: Option<&[String]>,
    sequence_columns: &[String],
) -> Vec<String> {
    let qualify = |table: &str| {
        format!(
            "\"{}\".\"{}\"",
            escape_identifier(schema),
            escape_identifier(table)
        )
    };
    let quote = |column: &str| format!("\"{}\"", escape_identifier(column));
    let src = qualify(source);
    let dst = qualify(target);
    let mut statements = vec![format!(
        "CREATE TABLE {} (LIKE {} INCLUDING ALL)",
        dst, src
    )];
    let Some(columns) = data_columns else {
        return statements;
    };
    statements.extend(crate::drivers::common::clone_insert_statement(
        &dst,
        &src,
        columns,
        quote,
        Some("OVERRIDING SYSTEM VALUE"),
    ));
    for column in sequence_columns.iter().filter(|c| columns.contains(*c)) {
        statements.push(format!(
            "SELECT setval(pg_get_serial_sequence('{}', '{}'), MAX({col})) FROM {dst} HAVING MAX({col}) IS NOT NULL",
            dst.replace('\'', "''"),
            column.replace('\'', "''"),
            col = quote(column),
            dst = dst,
        ));
    }
    statements
}
