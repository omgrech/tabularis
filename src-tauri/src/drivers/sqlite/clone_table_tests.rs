use super::clone_table::{clone_table_statements, rename_create_table, rewrite_create_index};

#[test]
fn rename_create_table_handles_quoting_styles() {
    let cases = [
        ("CREATE TABLE users (id INTEGER)", "CREATE TABLE \"copy\" (id INTEGER)"),
        ("CREATE TABLE \"my \"\"t\"(id)", "CREATE TABLE \"copy\"(id)"),
        ("CREATE TABLE [my t] (id)", "CREATE TABLE \"copy\" (id)"),
        ("CREATE TABLE `my``t` (id)", "CREATE TABLE \"copy\" (id)"),
        ("create table if not exists main.users(id)", "CREATE TABLE \"copy\"(id)"),
        ("CREATE TEMP TABLE t (id)", "CREATE TABLE \"copy\" (id)"),
    ];
    for (ddl, expected) in cases {
        assert_eq!(rename_create_table(ddl, "copy").as_deref(), Some(expected), "{ddl}");
    }
}

#[test]
fn rename_create_table_rejects_other_statements() {
    assert!(rename_create_table("CREATE VIEW v AS SELECT 1", "copy").is_none());
    assert!(rename_create_table("CREATE TABLE \"unterminated (id)", "copy").is_none());
    assert!(rename_create_table("CREATE TABLES t (id)", "copy").is_none());
}

#[test]
fn rewrite_create_index_renames_index_and_table() {
    assert_eq!(
        rewrite_create_index("CREATE INDEX idx_name ON users (name)", "users_copy").as_deref(),
        Some("CREATE INDEX \"users_copy_idx_name\" ON \"users_copy\" (name)")
    );
    assert_eq!(
        rewrite_create_index(
            "CREATE UNIQUE INDEX IF NOT EXISTS \"by email\" ON \"users\"(email) WHERE email IS NOT NULL",
            "u2"
        )
        .as_deref(),
        Some("CREATE UNIQUE INDEX \"u2_by email\" ON \"u2\"(email) WHERE email IS NOT NULL")
    );
}

#[test]
fn clone_statements_order_table_rows_then_indexes() {
    let columns = vec!["id".to_string(), "name".to_string()];
    let statements = clone_table_statements(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
        &["CREATE INDEX idx_name ON users (name)".to_string()],
        "users",
        "users_copy",
        Some(columns.as_slice()),
    )
    .unwrap();
    assert_eq!(
        statements,
        vec![
            "CREATE TABLE \"users_copy\" (id INTEGER PRIMARY KEY, name TEXT)".to_string(),
            "INSERT INTO \"users_copy\" (\"id\", \"name\") SELECT \"id\", \"name\" FROM \"users\"".to_string(),
            "CREATE INDEX \"users_copy_idx_name\" ON \"users_copy\" (name)".to_string(),
        ]
    );
}
