use super::{clone_data_columns, clone_insert_statement, validate_clone_table_names};
use crate::models::TableColumn;

fn column(name: &str, is_generated: bool) -> TableColumn {
    TableColumn {
        name: name.to_string(),
        data_type: "int".to_string(),
        is_pk: false,
        is_nullable: true,
        is_auto_increment: false,
        is_generated,
        default_value: None,
        character_maximum_length: None,
        numeric_precision: None,
        numeric_scale: None,
        comment: None,
    }
}

#[test]
fn rejects_blank_and_identical_target_names() {
    assert!(validate_clone_table_names("users", "").is_err());
    assert!(validate_clone_table_names("users", "   ").is_err());
    assert!(validate_clone_table_names("users", "users").is_err());
    assert!(validate_clone_table_names("users", "users_copy").is_ok());
    // Case differs: the database decides whether that collides.
    assert!(validate_clone_table_names("users", "Users").is_ok());
}

#[test]
fn data_columns_skip_generated_columns() {
    let columns = vec![column("id", false), column("total", true), column("name", false)];
    assert_eq!(clone_data_columns(&columns), vec!["id", "name"]);
}

#[test]
fn insert_statement_lists_columns_on_both_sides() {
    let sql = clone_insert_statement(
        "`b`",
        "`a`",
        &["id".to_string(), "name".to_string()],
        |c| format!("`{}`", c),
        None,
    );
    assert_eq!(
        sql.as_deref(),
        Some("INSERT INTO `b` (`id`, `name`) SELECT `id`, `name` FROM `a`")
    );
}

#[test]
fn insert_statement_places_modifier_before_select() {
    let sql = clone_insert_statement(
        "\"b\"",
        "\"a\"",
        &["id".to_string()],
        |c| format!("\"{}\"", c),
        Some("OVERRIDING SYSTEM VALUE"),
    );
    assert_eq!(
        sql.as_deref(),
        Some("INSERT INTO \"b\" (\"id\") OVERRIDING SYSTEM VALUE SELECT \"id\" FROM \"a\"")
    );
}

#[test]
fn insert_statement_is_skipped_without_columns() {
    assert!(clone_insert_statement("b", "a", &[], |c| c.to_string(), None).is_none());
}
