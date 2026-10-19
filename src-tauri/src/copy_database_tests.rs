use super::{
    existing_target_tables, is_same_location, run_copy, validate_copy_request, CopyDatabaseOptions,
    CopyEndpoint,
};
use crate::drivers::sqlite::SqliteDriver;
use crate::models::{ConnectionParams, DatabaseSelection};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;

fn options(
    tables: &[&str],
    structure: bool,
    data: bool,
    drop_existing: bool,
) -> CopyDatabaseOptions {
    CopyDatabaseOptions {
        tables: tables.iter().map(|t| t.to_string()).collect(),
        structure,
        data,
        drop_existing,
    }
}

#[test]
fn rejects_mixed_drivers_same_database_and_empty_requests() {
    let ok = options(&["a"], true, true, false);
    assert!(validate_copy_request("mysql", "mysql", false, &ok).is_ok());

    let err = validate_copy_request("mysql", "postgres", false, &ok).unwrap_err();
    assert!(err.contains("mysql to postgres"), "{err}");
    assert!(validate_copy_request("mysql", "mysql", true, &ok).is_err());
    assert!(
        validate_copy_request("mysql", "mysql", false, &options(&[], true, true, false)).is_err()
    );
    assert!(validate_copy_request(
        "mysql",
        "mysql",
        false,
        &options(&["a"], false, false, false)
    )
    .is_err());
}

#[test]
fn existing_tables_are_matched_case_insensitively() {
    let selected = vec![
        "Users".to_string(),
        "orders".to_string(),
        "logs".to_string(),
    ];
    let target = vec!["users".to_string(), "logs".to_string(), "other".to_string()];
    assert_eq!(
        existing_target_tables(&selected, &target),
        vec!["Users", "logs"]
    );
    assert!(existing_target_tables(&selected, &[]).is_empty());
}

fn server(host: &str, port: u16, database: &str) -> ConnectionParams {
    ConnectionParams {
        driver: "mysql".to_string(),
        host: Some(host.to_string()),
        port: Some(port),
        database: DatabaseSelection::Single(database.to_string()),
        ..Default::default()
    }
}

#[test]
fn same_location_covers_the_same_connection_and_the_same_server() {
    let a = server("10.0.0.5", 3306, "shop");
    // Same saved connection, same database.
    assert!(is_same_location("c1", &a, "c1", &a));
    // Two saved connections to the same server and database.
    assert!(is_same_location(
        "c1",
        &a,
        "c2",
        &server("10.0.0.5", 3306, "shop")
    ));
    // Another database, port or host is a real copy.
    assert!(!is_same_location(
        "c1",
        &a,
        "c1",
        &server("10.0.0.5", 3306, "shop_test")
    ));
    assert!(!is_same_location(
        "c1",
        &a,
        "c2",
        &server("10.0.0.5", 3307, "shop")
    ));
    assert!(!is_same_location(
        "c1",
        &a,
        "c2",
        &server("10.0.0.6", 3306, "shop")
    ));
}

struct TestDb {
    params: ConnectionParams,
    pool: SqlitePool,
    _file: NamedTempFile,
}

async fn sqlite_db(setup: &[&str]) -> TestDb {
    let file = NamedTempFile::new().unwrap();
    let path = file.path().to_str().unwrap().to_string();
    let pool = SqlitePoolOptions::new()
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    for sql in setup {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    TestDb {
        params: ConnectionParams {
            driver: "sqlite".to_string(),
            database: DatabaseSelection::Single(path),
            ..Default::default()
        },
        pool,
        _file: file,
    }
}

fn endpoint(db: &TestDb) -> CopyEndpoint {
    CopyEndpoint {
        driver: Arc::new(SqliteDriver::new()),
        driver_id: "sqlite".to_string(),
        params: db.params.clone(),
        schema: None,
    }
}

const SOURCE: &[&str] = &[
    "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)",
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL)",
    "INSERT INTO customers VALUES (1, 'Ann', NULL), (2, 'O''Brien', 'multi\nline'), (3, 'Zoë ☕', '')",
    "INSERT INTO orders VALUES (10, 1, 9.5), (11, 2, 20.25), (12, 2, 0)",
];

async fn rows(db: &TestDb, sql: &str) -> Vec<(i64, String)> {
    sqlx::query_as(sql).fetch_all(&db.pool).await.unwrap()
}

async fn table_names(db: &TestDb) -> Vec<String> {
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

const CUSTOMERS: &str =
    "SELECT id, name || '|' || COALESCE(note, '<null>') FROM customers ORDER BY id";

#[tokio::test]
async fn copies_structure_and_rows_to_another_database() {
    let source = sqlite_db(SOURCE).await;
    let target = sqlite_db(&[]).await;
    let seen = Mutex::new(Vec::new());

    run_copy(
        &endpoint(&source),
        &endpoint(&target),
        &options(&["customers", "orders"], true, true, false),
        &|index, table| seen.lock().unwrap().push((index, table.to_string())),
    )
    .await
    .unwrap();

    assert_eq!(
        rows(&target, CUSTOMERS).await,
        rows(&source, CUSTOMERS).await
    );
    let orders = "SELECT id, customer_id || ':' || total FROM orders ORDER BY id";
    assert_eq!(rows(&target, orders).await, rows(&source, orders).await);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(0, "customers".to_string()), (1, "orders".to_string())]
    );
}

#[tokio::test]
async fn refuses_to_overwrite_existing_tables_unless_asked() {
    let source = sqlite_db(SOURCE).await;
    let target =
        sqlite_db(&["CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, note TEXT)"]).await;

    let err = run_copy(
        &endpoint(&source),
        &endpoint(&target),
        &options(&["customers", "orders"], true, true, false),
        &|_, _| {},
    )
    .await
    .unwrap_err();
    assert!(
        err.contains("already exist") && err.contains("customers"),
        "{err}"
    );
    assert_eq!(
        table_names(&target).await,
        vec!["customers"],
        "nothing was copied"
    );

    // With "drop existing" the table is replaced, and copying twice does not
    // duplicate rows.
    for _ in 0..2 {
        run_copy(
            &endpoint(&source),
            &endpoint(&target),
            &options(&["customers", "orders"], true, true, true),
            &|_, _| {},
        )
        .await
        .unwrap();
    }
    assert_eq!(rows(&target, CUSTOMERS).await.len(), 3);
}

#[tokio::test]
async fn structure_only_creates_empty_tables_and_data_only_fills_them() {
    let source = sqlite_db(SOURCE).await;
    let target = sqlite_db(&[]).await;

    run_copy(
        &endpoint(&source),
        &endpoint(&target),
        &options(&["customers"], true, false, false),
        &|_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(table_names(&target).await, vec!["customers"]);
    assert!(rows(&target, CUSTOMERS).await.is_empty());

    run_copy(
        &endpoint(&source),
        &endpoint(&target),
        &options(&["customers"], false, true, false),
        &|_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(
        rows(&target, CUSTOMERS).await,
        rows(&source, CUSTOMERS).await
    );
}

#[tokio::test]
async fn a_failure_part_way_rolls_back_the_whole_copy() {
    let source = sqlite_db(SOURCE).await;
    let target = sqlite_db(&[]).await;

    let err = run_copy(
        &endpoint(&source),
        &endpoint(&target),
        &options(&["customers", "does_not_exist"], true, true, false),
        &|_, _| {},
    )
    .await
    .unwrap_err();
    assert!(err.contains("does_not_exist"), "{err}");
    assert!(
        table_names(&target).await.is_empty(),
        "the target is left as it was"
    );
}

#[tokio::test]
async fn binary_values_survive_the_copy() {
    let source = sqlite_db(&[
        "CREATE TABLE files (id INTEGER PRIMARY KEY, data BLOB)",
        "INSERT INTO files VALUES (1, X'00FF10'), (2, randomblob(50000)), (3, NULL), (4, X'')",
    ])
    .await;
    let target = sqlite_db(&[]).await;

    run_copy(
        &endpoint(&source),
        &endpoint(&target),
        &options(&["files"], true, true, false),
        &|_, _| {},
    )
    .await
    .unwrap();

    // `hex(NULL)` is '' in SQLite, the same as `hex(X'')`, so NULLs are
    // compared through `typeof`.
    let query = "SELECT id, typeof(data) || ':' || hex(data) FROM files ORDER BY id";
    let copied = rows(&target, query).await;
    assert_eq!(copied, rows(&source, query).await);
    assert_eq!(
        copied[1].1.len(),
        "blob:".len() + 100_000,
        "the 50 KB value is whole"
    );
    assert_eq!(copied[2].1, "null:");
}
