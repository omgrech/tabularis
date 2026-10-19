use super::clone_table::clone_table_statements;

#[test]
fn clone_table_structure_only_uses_create_like() {
    assert_eq!(
        clone_table_statements("users", "users_copy", None),
        vec!["CREATE TABLE `users_copy` LIKE `users`"]
    );
}

#[test]
fn clone_table_with_data_copies_listed_columns() {
    let columns = vec!["id".to_string(), "name".to_string()];
    assert_eq!(
        clone_table_statements("users", "users_copy", Some(columns.as_slice())),
        vec![
            "CREATE TABLE `users_copy` LIKE `users`".to_string(),
            "INSERT INTO `users_copy` (`id`, `name`) SELECT `id`, `name` FROM `users`".to_string(),
        ]
    );
}

#[test]
fn clone_table_escapes_backticks_in_identifiers() {
    let columns = vec!["we`ird".to_string()];
    let statements = clone_table_statements("a`b", "c`d", Some(columns.as_slice()));
    assert_eq!(statements[0], "CREATE TABLE `c``d` LIKE `a``b`");
    assert_eq!(
        statements[1],
        "INSERT INTO `c``d` (`we``ird`) SELECT `we``ird` FROM `a``b`"
    );
}

#[test]
fn clone_table_with_no_copyable_columns_skips_the_insert() {
    let statements = clone_table_statements("t", "t_copy", Some(&[] as &[String]));
    assert_eq!(statements, vec!["CREATE TABLE `t_copy` LIKE `t`"]);
}
