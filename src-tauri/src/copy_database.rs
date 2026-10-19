//! Copy Database: copies tables from one connection/database to another
//! (another database on the same server, or another server) without an
//! intermediate file. The source side is the Export code (`write_dump`), the
//! target side is the Import code (`execute_statements`); statements flow
//! between them through a bounded channel.

use crate::commands::{
    expand_k8s_connection_params, expand_ssh_connection_params, find_connection_by_id,
    register_abort_handle, resolve_connection_params_with_id, unregister_abort_handle,
};
use crate::drivers::driver_trait::DatabaseDriver;
use crate::dump_commands::{
    execute_statements, write_dump, DumpCancellationState, DumpPlan, DumpSink, StatementSource,
};
use crate::dump_utils::DumpDialect;
use crate::models::ConnectionParams;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::mpsc;

#[cfg(test)]
#[path = "copy_database_tests.rs"]
mod tests;

/// Statements buffered between the source and the target. Each data
/// statement carries up to 100 rows, so this bounds memory while letting the
/// source read ahead a little.
const CHANNEL_CAPACITY: usize = 16;

#[derive(Debug, Deserialize)]
pub struct CopyDatabaseOptions {
    pub tables: Vec<String>,
    pub structure: bool,
    pub data: bool,
    /// Drop target tables that already exist before recreating them.
    pub drop_existing: bool,
}

/// Emitted as `copy_database_progress` before each table is copied.
#[derive(Debug, Clone, Serialize)]
pub struct CopyDatabaseProgress {
    pub table: String,
    /// 0-based position of `table` in the selection.
    pub index: usize,
    pub total: usize,
}

/// One side of a copy: a resolved connection and the driver serving it.
pub(crate) struct CopyEndpoint {
    pub driver: Arc<dyn DatabaseDriver>,
    /// Driver id from the saved connection (`mysql`, `postgres`, a plugin id).
    pub driver_id: String,
    pub params: ConnectionParams,
    pub schema: Option<String>,
}

impl CopyEndpoint {
    fn dialect(&self) -> DumpDialect {
        DumpDialect::from_capabilities(&self.driver_id, &self.driver.manifest().capabilities)
    }
}

/// Sends the statements `write_dump` produces to the target side.
struct ChannelSink {
    tx: mpsc::Sender<String>,
}

#[async_trait]
impl DumpSink for ChannelSink {
    async fn comment(&mut self, _text: &str) -> Result<(), String> {
        Ok(())
    }

    async fn statement(&mut self, sql: &str) -> Result<(), String> {
        self.tx
            .send(sql.to_string())
            .await
            .map_err(|_| "The target connection stopped accepting statements".to_string())
    }

    async fn blank_line(&mut self) -> Result<(), String> {
        Ok(())
    }

    async fn missing_ddl(&mut self, table_ref: &str, error: &str) -> Result<(), String> {
        Err(format!(
            "Could not read the structure of {}: {}",
            table_ref, error
        ))
    }
}

/// Feeds the target side the statements the source side sends.
struct ChannelSource {
    rx: mpsc::Receiver<String>,
}

#[async_trait]
impl StatementSource for ChannelSource {
    async fn next_statement(&mut self) -> Result<Option<String>, String> {
        Ok(self.rx.recv().await)
    }
}

/// Checks a copy request before anything touches the target.
pub(crate) fn validate_copy_request(
    source_driver: &str,
    target_driver: &str,
    same_location: bool,
    options: &CopyDatabaseOptions,
) -> Result<(), String> {
    if source_driver != target_driver {
        return Err(format!(
            "Copying between different database types ({} to {}) is not supported",
            source_driver, target_driver
        ));
    }
    if same_location {
        return Err("The source and the target are the same database".into());
    }
    if options.tables.is_empty() {
        return Err("Select at least one table to copy".into());
    }
    if !options.structure && !options.data {
        return Err("Choose to copy the structure, the data, or both".into());
    }
    Ok(())
}

/// Whether two resolved endpoints are the same database: the same saved
/// connection, or two connections to the same host and port, browsing the
/// same database. Copying a database onto itself would drop its own tables.
pub(crate) fn is_same_location(
    source_id: &str,
    source: &ConnectionParams,
    target_id: &str,
    target: &ConnectionParams,
) -> bool {
    let same_server =
        source_id == target_id || (source.host == target.host && source.port == target.port);
    same_server && source.database.primary() == target.database.primary()
}

/// Selected tables that already exist in the target (case-insensitively,
/// since MySQL on Windows and macOS folds table names).
pub(crate) fn existing_target_tables(selected: &[String], target_tables: &[String]) -> Vec<String> {
    selected
        .iter()
        .filter(|name| target_tables.iter().any(|t| t.eq_ignore_ascii_case(name)))
        .cloned()
        .collect()
}

/// Copies `options.tables` from `source` to `target`. On the built-in
/// drivers the target side runs in one transaction with foreign key checks
/// off, like Import; a failure on either side stops both.
pub(crate) async fn run_copy(
    source: &CopyEndpoint,
    target: &CopyEndpoint,
    options: &CopyDatabaseOptions,
    on_table: &(dyn Fn(usize, &str) + Send + Sync),
) -> Result<(), String> {
    let source_dialect = source.dialect();
    let source_schema = source_dialect.resolve_schema(source.schema.as_deref());
    let source_scoped = source_dialect.scoped_schema(source_schema.as_deref());

    let target_dialect = target.dialect();
    let target_schema = target_dialect.resolve_schema(target.schema.as_deref());
    let target_scoped = target_dialect.scoped_schema(target_schema.as_deref());

    // Without "drop existing", recreating a table that is already there
    // would fail halfway through the copy. Refuse up front instead.
    if options.structure && !options.drop_existing {
        let target_tables: Vec<String> = target
            .driver
            .get_tables(&target.params, target_scoped)
            .await?
            .into_iter()
            .map(|t| t.name)
            .collect();
        let clashes = existing_target_tables(&options.tables, &target_tables);
        if !clashes.is_empty() {
            return Err(format!(
                "These tables already exist in the target: {}. Choose to drop existing tables to replace them.",
                clashes.join(", ")
            ));
        }
    }

    let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
    let plan = DumpPlan {
        tables: &options.tables,
        structure: options.structure,
        data: options.data,
        drop_existing: options.drop_existing,
    };

    let produce = async {
        let mut sink = ChannelSink { tx };
        write_dump(
            &mut sink,
            &source.driver,
            &source.params,
            &source.driver_id,
            &source_dialect,
            source_scoped,
            &plan,
            on_table,
        )
        .await
        // `sink` (and with it the sender) is dropped here, which ends the
        // target side's statement stream.
    };
    let consume = async {
        let mut source_stream = ChannelSource { rx };
        execute_statements(
            &mut source_stream,
            &target.driver,
            &target.params,
            &target.driver_id,
            target_schema.as_deref(),
            target_dialect.postgres,
            &|_| {},
        )
        .await
    };

    tokio::try_join!(produce, consume).map(|_| ())
}

/// Slot key for the cancellation registry, distinct from dump and import.
fn copy_slot_key(source_connection_id: &str) -> String {
    format!("{}_copy", source_connection_id)
}

async fn resolve_endpoint<R: Runtime>(
    app: &AppHandle<R>,
    connection_id: &str,
    database: Option<String>,
    schema: Option<String>,
) -> Result<CopyEndpoint, String> {
    let saved = find_connection_by_id(app, connection_id)?;
    let expanded = expand_ssh_connection_params(app, &saved.params).await?;
    let expanded = expand_k8s_connection_params(app, &expanded).await?;
    let mut params = resolve_connection_params_with_id(&expanded, connection_id)?;
    if let Some(db) = database.filter(|d| !d.is_empty()) {
        params.database = crate::models::DatabaseSelection::Single(db);
    }
    let driver = crate::drivers::registry::get_connection_driver(&params).await?;
    Ok(CopyEndpoint {
        driver,
        driver_id: saved.params.driver.clone(),
        params,
        schema,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn copy_database<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DumpCancellationState>,
    source_connection_id: String,
    source_database: Option<String>,
    target_connection_id: String,
    target_database: Option<String>,
    schema: Option<String>,
    options: CopyDatabaseOptions,
) -> Result<(), String> {
    let source =
        resolve_endpoint(&app, &source_connection_id, source_database, schema.clone()).await?;
    let target = resolve_endpoint(&app, &target_connection_id, target_database, schema).await?;
    let same_location = is_same_location(
        &source_connection_id,
        &source.params,
        &target_connection_id,
        &target.params,
    );
    validate_copy_request(
        &source.driver_id,
        &target.driver_id,
        same_location,
        &options,
    )?;

    let app_handle = app.clone();
    let task = tokio::spawn(async move {
        let total = options.tables.len();
        run_copy(&source, &target, &options, &|index, table| {
            let _ = app_handle.emit(
                "copy_database_progress",
                CopyDatabaseProgress {
                    table: table.to_string(),
                    index,
                    total,
                },
            );
        })
        .await
    });

    let key = copy_slot_key(&source_connection_id);
    let abort_handle = Arc::new(task.abort_handle());
    register_abort_handle(&state.handles, key.clone(), abort_handle.clone());
    let result = task.await;
    unregister_abort_handle(&state.handles, &key, &abort_handle);

    match result {
        Ok(res) => res,
        Err(_) => Err("Copy cancelled".into()),
    }
}

#[tauri::command]
pub async fn cancel_copy_database(
    state: State<'_, DumpCancellationState>,
    source_connection_id: String,
) -> Result<(), String> {
    let entries = {
        let mut handles = state.handles.lock().unwrap();
        handles
            .remove(&copy_slot_key(&source_connection_id))
            .unwrap_or_default()
    };
    if entries.is_empty() {
        return Err("No active copy found".into());
    }
    for handle in entries {
        handle.abort();
    }
    Ok(())
}
