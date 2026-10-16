//! Wire envelope: `{ "<uuid>": { "t": action, "e": kind, "p": payload } }`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub mod action {
    pub const CREATE: u8 = 0;
    pub const MODIFY: u8 = 1;
    pub const DELETE: u8 = 2;
}

/// Kinds we write. Reading also accepts older versions (see [`Family`]).
pub mod kind {
    pub const TASK: &str = "Task6";
    pub const CHECKLIST_ITEM: &str = "ChecklistItem3";
    pub const AREA: &str = "Area3";
    pub const TAG: &str = "Tag4";
    pub const TOMBSTONE: &str = "Tombstone2";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Task,
    ChecklistItem,
    Area,
    Tag,
    Tombstone,
    Settings,
}

impl Family {
    pub fn of(kind: &str) -> Option<Family> {
        Some(match kind {
            "Task6" | "Task4" | "Task3" | "Task" => Family::Task,
            "ChecklistItem3" | "ChecklistItem2" | "ChecklistItem" => Family::ChecklistItem,
            "Area3" | "Area2" | "Area" => Family::Area,
            "Tag4" | "Tag3" | "Tag" => Family::Tag,
            "Tombstone2" | "Tombstone" => Family::Tombstone,
            k if is_settings(k) => Family::Settings,
            _ => return None,
        })
    }
}

/// Kinds from before the Base58 identifier migration; their ids and
/// references are normalised with [`crate::id::legacy`].
pub fn is_legacy_kind(kind: &str) -> bool {
    matches!(kind, "Task4" | "Task3" | "Task" | "ChecklistItem2" | "ChecklistItem" | "Area2" | "Area" | "Tag3" | "Tag" | "Tombstone")
}

fn is_settings(kind: &str) -> bool {
    kind.strip_prefix("Settings").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// One entity event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub uuid: String,
    pub kind: String,
    pub action: u8,
    pub payload: Value,
}

impl Item {
    pub fn new(uuid: impl Into<String>, kind: &str, action: u8, payload: Value) -> Self {
        Item { uuid: uuid.into(), kind: kind.to_string(), action, payload }
    }

    pub fn payload_obj(&self) -> Option<&Map<String, Value>> {
        self.payload.as_object()
    }
}

#[derive(Deserialize)]
struct RawEnvelope {
    t: u8,
    e: String,
    #[serde(default)]
    p: Value,
}

/// Parses one outer entry of an `items` response (`{uuid: envelope, …}`).
pub fn parse_entry(entry: &Value) -> Result<Vec<Item>, String> {
    let map = entry.as_object().ok_or("history entry is not an object")?;
    let mut items = Vec::with_capacity(map.len());
    for (uuid, env) in map {
        let raw: RawEnvelope = serde_json::from_value(env.clone()).map_err(|e| format!("item {uuid}: {e}"))?;
        items.push(Item { uuid: uuid.clone(), kind: raw.e, action: raw.t, payload: raw.p });
    }
    Ok(items)
}

/// Builds the commit request body.
pub fn commit_body(items: &[Item]) -> Value {
    let mut map = Map::new();
    for item in items {
        map.insert(item.uuid.clone(), serde_json::json!({ "t": item.action, "e": item.kind, "p": item.payload }));
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn families_and_settings() {
        assert_eq!(Family::of("Task6"), Some(Family::Task));
        assert_eq!(Family::of("Tag3"), Some(Family::Tag));
        assert_eq!(Family::of("Settings5"), Some(Family::Settings));
        assert_eq!(Family::of("Settings"), None);
        assert_eq!(Family::of("Task7"), None, "unknown future kinds fail closed");
        assert!(is_legacy_kind("Task4"));
        assert!(!is_legacy_kind("Task6"));
    }

    #[test]
    fn parses_entries_and_builds_commit_body() {
        let entry = json!({"A": {"t": 0, "e": "Area3", "p": {"tt": "Home"}}, "B": {"t": 2, "e": "Tag4"}});
        let items = parse_entry(&entry).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].uuid, "A");
        assert_eq!(items[1].payload, Value::Null);
        let body = commit_body(&items[..1]);
        assert_eq!(body, json!({"A": {"t": 0, "e": "Area3", "p": {"tt": "Home"}}}));
        assert!(parse_entry(&json!([1])).is_err());
    }
}
