use std::fmt;
use zeroize::Zeroize;

/// A credential (password or history key). Its `Debug` and `Display` output is
/// redacted so it cannot leak through logs or error messages by accident, and
/// the memory is zeroed on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }

    /// Returns the raw value. Call sites should be few and obvious.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Full SHA-1 hex digest. Safe to store for high-entropy secrets such as
    /// the history key (used to bind a local cache to one history).
    pub fn digest_hex(&self) -> String {
        use sha1::{Digest, Sha1};
        Sha1::digest(self.0.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A short non-reversible label (first 4 chars of a SHA-1) safe for logs.
    pub fn fingerprint(&self) -> String {
        use sha1::{Digest, Sha1};
        let digest = Sha1::digest(self.0.as_bytes());
        digest.iter().take(2).map(|b| format!("{b:02x}")).collect()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_display_are_redacted() {
        let s = Secret::new("hunter2");
        assert_eq!(format!("{s:?}"), "Secret(***)");
        assert_eq!(format!("{s}"), "***");
        assert!(!format!("{s:?} {s}").contains("hunter2"));
        assert_eq!(s.fingerprint().len(), 4);
    }
}
