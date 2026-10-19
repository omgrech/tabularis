use super::clone_table::clone_table_statements;

#[test]
fn structure_only_uses_like_including_all() {
    assert_eq!(
        clone_table_statements("public", "users", "users_copy", None, &[]),
        vec!["CREATE TABLE \"public\".\"users_copy\" (LIKE \"public\".\"users\" INCLUDING ALL)"]
    );
}

#[test]
fn data_copy_overrides_identity_and_resets_sequences() {
    let columns = vec!["id".to_string(), "name".to_string()];
    let statements = clone_table_statements(
        "sales",
        "orders",
        "orders_copy",
        Some(columns.as_slice()),
        &["id".to_string()],
    );
    assert_eq!(
        statements,
        vec![
            "CREATE TABLE \"sales\".\"orders_copy\" (LIKE \"sales\".\"orders\" INCLUDING ALL)".to_string(),
            "INSERT INTO \"sales\".\"orders_copy\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE SELECT \"id\", \"name\" FROM \"sales\".\"orders\"".to_string(),
            "SELECT setval(pg_get_serial_sequence('\"sales\".\"orders_copy\"', 'id'), MAX(\"id\")) FROM \"sales\".\"orders_copy\" HAVING MAX(\"id\") IS NOT NULL".to_string(),
        ]
    );
}

#[test]
fn sequence_reset_skips_columns_that_are_not_copied() {
    let columns = vec!["name".to_string()];
    let statements = clone_table_statements(
        "public",
        "t",
        "t_copy",
        Some(columns.as_slice()),
        &["id".to_string()],
    );
    assert_eq!(statements.len(), 2);
}

#[test]
fn quotes_are_escaped_in_identifiers_and_literals() {
    let columns = vec!["it's".to_string()];
    let statements = clone_table_statements(
        "sch\"ema",
        "a",
        "o'b\"x",
        Some(columns.as_slice()),
        &["it's".to_string()],
    );
    assert_eq!(
        statements[0],
        "CREATE TABLE \"sch\"\"ema\".\"o'b\"\"x\" (LIKE \"sch\"\"ema\".\"a\" INCLUDING ALL)"
    );
    assert_eq!(
        statements[2],
        "SELECT setval(pg_get_serial_sequence('\"sch\"\"ema\".\"o''b\"\"x\"', 'it''s'), MAX(\"it's\")) FROM \"sch\"\"ema\".\"o'b\"\"x\" HAVING MAX(\"it's\") IS NOT NULL"
    );
}
