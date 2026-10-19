//! Pure SQL builders for the explorer's "Clone table" action.

use super::helpers::escape_identifier;

/// Statements for the explorer's "Clone table" action. `CREATE TABLE ...
/// LIKE` copies columns, keys, indexes and table options. It does not copy
/// foreign keys, whose constraint names must be unique per database.
/// `data_columns` lists the columns to copy rows for; `None` copies the
/// structure only.
pub(super) fn clone_table_statements(
    source: &str,
    target: &str,
    data_columns: Option<&[String]>,
) -> Vec<String> {
    let src = format!("`{}`", escape_identifier(source));
    let dst = format!("`{}`", escape_identifier(target));
    let mut statements = vec![format!("CREATE TABLE {} LIKE {}", dst, src)];
    if let Some(columns) = data_columns {
        statements.extend(crate::drivers::common::clone_insert_statement(
            &dst,
            &src,
            columns,
            |c| format!("`{}`", escape_identifier(c)),
            None,
        ));
    }
    statements
}
