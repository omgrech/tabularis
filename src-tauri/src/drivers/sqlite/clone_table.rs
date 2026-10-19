//! Pure SQL builders for the explorer's "Clone table" action: rewrite the
//! stored `CREATE TABLE`/`CREATE INDEX` statements for the new table.

use super::escape_identifier;

fn is_identifier_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Skips leading whitespace and `keyword` (case-insensitive, whole word).
fn skip_keyword<'a>(s: &'a str, keyword: &str) -> Option<&'a str> {
    let t = s.trim_start();
    let head = t.get(..keyword.len())?;
    if !head.eq_ignore_ascii_case(keyword) {
        return None;
    }
    let rest = &t[keyword.len()..];
    if rest.chars().next().is_some_and(is_identifier_char) {
        return None;
    }
    Some(rest)
}

/// Skips an optional `IF NOT EXISTS`.
fn skip_if_not_exists(s: &str) -> Option<&str> {
    match skip_keyword(s, "IF") {
        Some(rest) => skip_keyword(rest, "NOT").and_then(|r| skip_keyword(r, "EXISTS")),
        None => Some(s),
    }
}

/// Byte length of the identifier token at the start of `t`: bare, or quoted
/// with "...", `...`, '...' (doubled quote escapes) or [...].
fn identifier_len(t: &str) -> Option<usize> {
    let first = t.chars().next()?;
    match first {
        '"' | '`' | '\'' => {
            let bytes = t.as_bytes();
            let quote = bytes[0];
            let mut i = 1;
            while i < bytes.len() {
                if bytes[i] == quote {
                    if bytes.get(i + 1) == Some(&quote) {
                        i += 2;
                        continue;
                    }
                    return Some(i + 1);
                }
                i += 1;
            }
            None
        }
        '[' => t.find(']').map(|p| p + 1),
        c if is_identifier_char(c) => Some(t.find(|c| !is_identifier_char(c)).unwrap_or(t.len())),
        _ => None,
    }
}

/// Parses an optionally schema-qualified name at the start of `s`. Returns
/// the last identifier token (still quoted) and the text after the name.
fn qualified_name(s: &str) -> Option<(&str, &str)> {
    let t = s.trim_start();
    let len = identifier_len(t)?;
    let (mut token, mut rest) = (&t[..len], &t[len..]);
    if let Some(after_dot) = rest.trim_start().strip_prefix('.') {
        let t = after_dot.trim_start();
        let len = identifier_len(t)?;
        token = &t[..len];
        rest = &t[len..];
    }
    Some((token, rest))
}

fn unquote_identifier(token: &str) -> String {
    match token.chars().next() {
        Some(q @ ('"' | '`' | '\'')) if token.len() >= 2 => {
            let inner = &token[1..token.len() - 1];
            inner.replace(&format!("{q}{q}"), &q.to_string())
        }
        Some('[') if token.len() >= 2 => token[1..token.len() - 1].to_string(),
        _ => token.to_string(),
    }
}

/// Rewrites a stored `CREATE TABLE` statement to create `target` instead.
pub(super) fn rename_create_table(ddl: &str, target: &str) -> Option<String> {
    let s = skip_keyword(ddl, "CREATE")?;
    let s = skip_keyword(s, "TEMPORARY")
        .or_else(|| skip_keyword(s, "TEMP"))
        .unwrap_or(s);
    let s = skip_if_not_exists(skip_keyword(s, "TABLE")?)?;
    let (_, rest) = qualified_name(s)?;
    Some(format!("CREATE TABLE \"{}\"{}", escape_identifier(target), rest))
}

/// Rewrites a stored `CREATE INDEX` statement to index `target`. Index
/// names are unique per database, so the copy is named `<target>_<index>`.
pub(super) fn rewrite_create_index(ddl: &str, target: &str) -> Option<String> {
    let s = skip_keyword(ddl, "CREATE")?;
    let (unique, s) = match skip_keyword(s, "UNIQUE") {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let s = skip_if_not_exists(skip_keyword(s, "INDEX")?)?;
    let (name, rest) = qualified_name(s)?;
    let (_, rest) = qualified_name(skip_keyword(rest, "ON")?)?;
    let new_name = format!("{}_{}", target, unquote_identifier(name));
    Some(format!(
        "CREATE {}INDEX \"{}\" ON \"{}\"{}",
        if unique { "UNIQUE " } else { "" },
        escape_identifier(&new_name),
        escape_identifier(target),
        rest
    ))
}

/// Statements for the explorer's "Clone table" action, built from the
/// source table's stored definition: the table itself (with its keys,
/// constraints and foreign keys), its rows when `data_columns` is set, then
/// its indexes. Triggers are not copied.
pub(super) fn clone_table_statements(
    create_sql: &str,
    index_sqls: &[String],
    source: &str,
    target: &str,
    data_columns: Option<&[String]>,
) -> Result<Vec<String>, String> {
    let unreadable = || format!("Could not read the definition of table \"{}\"", source);
    let create_sql = create_sql.trim().trim_end_matches(';').trim_end();
    let mut statements = vec![rename_create_table(create_sql, target).ok_or_else(unreadable)?];
    if let Some(columns) = data_columns {
        statements.extend(crate::drivers::common::clone_insert_statement(
            &format!("\"{}\"", escape_identifier(target)),
            &format!("\"{}\"", escape_identifier(source)),
            columns,
            |c| format!("\"{}\"", escape_identifier(c)),
            None,
        ));
    }
    for index_sql in index_sqls {
        statements.push(rewrite_create_index(index_sql.trim(), target).ok_or_else(unreadable)?);
    }
    Ok(statements)
}
