//! Task notes. Things stores notes as `{"_t":"tx","t":1,"ch":crc32,"v":text}`
//! (full text) or `{"t":2,"ps":[patches]}` (delta). Very old items use a plain
//! string, sometimes wrapped in `<note xml:space="preserve">…</note>`.

use serde_json::{json, Value};

pub fn checksum(text: &str) -> u32 {
    crc32fast::hash(text.as_bytes())
}

/// Wire value for a full-text note (also used to clear: empty text, ch 0).
pub fn wire(text: &str) -> Value {
    let ch = if text.is_empty() { 0 } else { checksum(text) };
    json!({ "_t": "tx", "ch": ch, "v": text, "t": 1 })
}

/// Applies a note value from the wire to the current text.
pub fn apply(current: &str, value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => strip_legacy_xml(s),
        Value::Object(map) => match map.get("t").and_then(Value::as_i64) {
            Some(2) => {
                let patches = map.get("ps").and_then(Value::as_array).cloned().unwrap_or_default();
                apply_patches(current, &patches)
            }
            _ => map.get("v").and_then(Value::as_str).unwrap_or("").to_string(),
        },
        _ => current.to_string(),
    }
}

fn strip_legacy_xml(s: &str) -> String {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("<note") {
        if let (Some(start), Some(end)) = (rest.find('>'), rest.rfind("</note>")) {
            if start < end {
                return unescape_xml(&rest[start + 1..end]);
            }
        }
    }
    s.to_string()
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// Applies `{r, p, l}` replacement patches on Unicode scalar positions, with
/// the same bounds clamping as the reference SDK.
pub fn apply_patches(original: &str, patches: &[Value]) -> String {
    let mut chars: Vec<char> = original.chars().collect();
    for p in patches {
        let replacement = p.get("r").and_then(Value::as_str).unwrap_or("");
        let pos = p.get("p").and_then(Value::as_i64).unwrap_or(0).clamp(0, chars.len() as i64) as usize;
        let len = p.get("l").and_then(Value::as_i64).unwrap_or(0).max(0) as usize;
        let end = (pos + len).min(chars.len());
        chars.splice(pos..end, replacement.chars());
    }
    chars.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_text_wire_shape() {
        let v = wire("hello");
        assert_eq!(v["_t"], "tx");
        assert_eq!(v["t"], 1);
        assert_eq!(v["v"], "hello");
        assert_eq!(v["ch"], crc32fast::hash(b"hello"));
        assert_eq!(wire("")["ch"], 0);
    }

    #[test]
    fn applies_all_note_forms() {
        assert_eq!(apply("x", &json!(null)), "");
        assert_eq!(apply("x", &json!("plain")), "plain");
        assert_eq!(apply("", &json!("<note xml:space=\"preserve\">a &amp; b</note>")), "a & b");
        assert_eq!(apply("", &wire("full")), "full");
        let delta = json!({"_t":"tx","t":2,"ps":[{"r":"brave new","p":6,"l":5,"ch":0}]});
        assert_eq!(apply("hello world", &delta), "hello brave new");
    }

    #[test]
    fn patches_clamp_out_of_range_positions() {
        let ps = vec![json!({"r":"!","p":99,"l":4})];
        assert_eq!(apply_patches("héllo", &ps), "héllo!");
        let ps = vec![json!({"r":"","p":-3,"l":2})];
        assert_eq!(apply_patches("héllo", &ps), "llo");
    }
}
