//! Things identifiers: canonical Base58 (Bitcoin alphabet) encodings of 16
//! bytes. A malformed identifier written to the cloud crashes Things.app on
//! every later sync, so every id we write is validated with [`validate`].

use sha1::{Digest, Sha1};

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IdError {
    #[error("empty identifier")]
    Empty,
    #[error("invalid Base58 character {0:?}")]
    InvalidChar(char),
    #[error("identifier does not decode to 16 bytes")]
    WrongLength,
}

/// Encodes 16 bytes as Base58, preserving leading zero bytes as `1`s.
pub fn encode(bytes: [u8; 16]) -> String {
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut n = u128::from_be_bytes(bytes);
    let mut out = Vec::with_capacity(22);
    while n > 0 {
        out.push(ALPHABET[(n % 58) as usize]);
        n /= 58;
    }
    out.extend(std::iter::repeat_n(b'1', zeros));
    out.reverse();
    String::from_utf8(out).expect("alphabet is ASCII")
}

/// Decodes a canonical identifier back into 16 bytes.
pub fn decode(s: &str) -> Result<[u8; 16], IdError> {
    if s.is_empty() {
        return Err(IdError::Empty);
    }
    let zeros = s.bytes().take_while(|b| *b == b'1').count();
    let mut n: u128 = 0;
    for c in s[zeros..].chars() {
        let digit = ALPHABET.iter().position(|a| *a as char == c).ok_or(IdError::InvalidChar(c))? as u128;
        n = n.checked_mul(58).and_then(|v| v.checked_add(digit)).ok_or(IdError::WrongLength)?;
    }
    let value_len = 16 - (n.leading_zeros() as usize / 8);
    if zeros + value_len != 16 {
        return Err(IdError::WrongLength);
    }
    Ok(n.to_be_bytes())
}

pub fn validate(s: &str) -> Result<(), IdError> {
    decode(s).map(|_| ())
}

pub fn is_valid(s: &str) -> bool {
    validate(s).is_ok()
}

/// Generates a new random identifier (UUID v4 bytes, Base58-encoded).
pub fn new_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random number generator unavailable");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    encode(bytes)
}

/// Maps an identifier from before Things migrated to Base58 (UUID-style or
/// built-in names such as `CC-Things-Tag-High`) to the identifier modern
/// clients use, exactly like the reference SDK: SHA-1 of the raw bytes,
/// truncated to 16 bytes. Recurring instances `<uuid>-YYYYMMDD` use a
/// two-stage hash.
pub fn legacy(legacy_id: &str) -> String {
    if legacy_id.is_empty() {
        return String::new();
    }
    let input: Vec<u8> = match split_legacy_recurrence(legacy_id) {
        Some((prefix, suffix)) => {
            let prefix_sum = Sha1::digest(prefix.as_bytes());
            let mut v = prefix_sum[..16].to_vec();
            v.extend_from_slice(suffix.as_bytes());
            v
        }
        None => legacy_id.as_bytes().to_vec(),
    };
    let sum = Sha1::digest(&input);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&sum[..16]);
    encode(bytes)
}

/// Returns the identifier unchanged if valid, otherwise its legacy mapping.
pub fn normalize(id: &str) -> String {
    if is_valid(id) {
        id.to_string()
    } else {
        legacy(id)
    }
}

fn split_legacy_recurrence(id: &str) -> Option<(&str, &str)> {
    const UUID_LEN: usize = 36;
    if id.len() != UUID_LEN + 9 || !id.is_ascii() {
        return None;
    }
    let (prefix, suffix) = id.split_at(UUID_LEN);
    if !looks_like_uuid(prefix) || !suffix.starts_with('-') {
        return None;
    }
    if !suffix[1..].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((prefix, suffix))
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_random_ids() {
        for _ in 0..500 {
            let id = new_id();
            assert!(id.len() == 21 || id.len() == 22, "{id}");
            let bytes = decode(&id).unwrap();
            assert_eq!(encode(bytes), id);
        }
    }

    #[test]
    fn preserves_leading_zero_bytes() {
        let mut bytes = [0xffu8; 16];
        bytes[0] = 0;
        bytes[1] = 0;
        let id = encode(bytes);
        assert!(id.starts_with("11"));
        assert_eq!(decode(&id).unwrap(), bytes);
    }

    #[test]
    fn rejects_non_canonical_ids() {
        assert_eq!(validate(""), Err(IdError::Empty));
        assert_eq!(validate("0OIl"), Err(IdError::InvalidChar('0')));
        // Standard UUID strings crash Things.app; they must not validate.
        assert!(validate("AD55F048-9A28-4260-A07B-6BA5C0D39AC9").is_err());
        assert!(validate("abc").is_err());
        assert!(validate("zzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
    }

    #[test]
    fn known_vector_from_things_capture() {
        // Real Things identifier seen in the SDK's HAR capture.
        assert!(is_valid("Q9sihFX2SsvGaz6vv4J2Hf"));
    }

    #[test]
    fn legacy_ids_are_deterministic_and_valid() {
        let a = legacy("CC-Things-Tag-High");
        assert!(is_valid(&a));
        assert_eq!(a, legacy("CC-Things-Tag-High"));
        assert_ne!(a, legacy("cc-things-tag-high"), "hash is case-sensitive");
        let r = legacy("AD55F048-9A28-4260-A07B-6BA5C0D39AC9-20240105");
        assert!(is_valid(&r));
        assert_ne!(r, legacy("AD55F048-9A28-4260-A07B-6BA5C0D39AC9"));
        assert_eq!(normalize(&a), a);
    }
}
