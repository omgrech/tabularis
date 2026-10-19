//! Shared helpers for the explorer's "Clone table" action
//! (`DatabaseDriver::get_clone_table_sql`).

use crate::models::TableColumn;

#[cfg(test)]
#[path = "clone_table_tests.rs"]
mod tests;

/// Rejects a clone whose target name is blank or equal to the source. The
/// database would reject both too, but with a less helpful message.
pub fn validate_clone_table_names(source: &str, target: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("The new table name cannot be empty".into());
    }
    if target == source {
        return Err("The new table name must differ from the source table".into());
    }
    Ok(())
}

/// Columns whose values are copied when cloning with data. Generated
/// columns are computed by the database and reject explicit values.
pub fn clone_data_columns(columns: &[TableColumn]) -> Vec<String> {
    columns
        .iter()
        .filter(|c| !c.is_generated)
        .map(|c| c.name.clone())
        .collect()
}

/// `INSERT INTO target (cols) SELECT cols FROM source`, or `None` when
/// there is nothing to copy. `quote` renders one identifier for the
/// driver's dialect; `target`/`source` arrive already quoted (they may be
/// schema-qualified). `insert_modifier` goes between the column list and
/// the `SELECT` (e.g. PostgreSQL's `OVERRIDING SYSTEM VALUE`).
pub fn clone_insert_statement(
    target: &str,
    source: &str,
    columns: &[String],
    quote: impl Fn(&str) -> String,
    insert_modifier: Option<&str>,
) -> Option<String> {
    if columns.is_empty() {
        return None;
    }
    let list = columns
        .iter()
        .map(|c| quote(c))
        .collect::<Vec<_>>()
        .join(", ");
    let modifier = insert_modifier
        .map(|m| format!(" {}", m))
        .unwrap_or_default();
    Some(format!(
        "INSERT INTO {} ({}){} SELECT {} FROM {}",
        target, list, modifier, list, source
    ))
}
