//! Credential storage in the operating system's protected store.
//!
//! On Windows this is the Credential Manager, whose secrets are encrypted with
//! DPAPI and readable only by the signed-in Windows user. Nothing secret is
//! ever written to the SQLite cache, the settings file, logs or the UI.
//! If secure storage is unavailable, connecting fails — there is no plaintext
//! fallback.

use serde_json::{json, Value};
use things_cloud::Secret;

const SERVICE: &str = "Cairn (Things Cloud)";

pub struct StoredCredentials {
    pub password: Secret,
    pub history_key: Secret,
}

#[derive(Debug, thiserror::Error)]
#[error("Secure credential storage failed: {0}")]
pub struct CredentialError(String);

pub trait CredentialStore: Send + Sync {
    fn load(&self, email: &str) -> Result<Option<StoredCredentials>, CredentialError>;
    fn save(&self, email: &str, creds: &StoredCredentials) -> Result<(), CredentialError>;
    fn delete(&self, email: &str) -> Result<(), CredentialError>;
}

/// Windows Credential Manager (or the platform equivalent in development).
pub struct OsCredentialStore;

impl OsCredentialStore {
    fn entry(email: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(SERVICE, email).map_err(|e| CredentialError(e.to_string()))
    }
}

impl CredentialStore for OsCredentialStore {
    fn load(&self, email: &str) -> Result<Option<StoredCredentials>, CredentialError> {
        match Self::entry(email)?.get_password() {
            Ok(raw) => {
                let raw = Secret::new(raw);
                let v: Value = serde_json::from_str(raw.expose()).map_err(|_| CredentialError("stored credentials are unreadable".into()))?;
                let field = |k: &str| v.get(k).and_then(Value::as_str).map(Secret::new);
                match (field("password"), field("historyKey")) {
                    (Some(password), Some(history_key)) => Ok(Some(StoredCredentials { password, history_key })),
                    _ => Err(CredentialError("stored credentials are incomplete".into())),
                }
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CredentialError(e.to_string())),
        }
    }

    fn save(&self, email: &str, creds: &StoredCredentials) -> Result<(), CredentialError> {
        let blob = Secret::new(json!({ "password": creds.password.expose(), "historyKey": creds.history_key.expose() }).to_string());
        Self::entry(email)?.set_password(blob.expose()).map_err(|e| CredentialError(e.to_string()))
    }

    fn delete(&self, email: &str) -> Result<(), CredentialError> {
        match Self::entry(email)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CredentialError(e.to_string())),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Runs on the Windows CI runner: proves secrets round-trip through the
    /// real Credential Manager and are removed again. Uses a throwaway name.
    #[test]
    fn windows_credential_manager_round_trip() {
        let store = OsCredentialStore;
        let user = format!("cairn-ci-{}@example.invalid", things_cloud::id::new_id());
        let creds = StoredCredentials { password: Secret::new("not-a-real-password"), history_key: Secret::new("not-a-real-key") };
        store.save(&user, &creds).expect("save");
        let loaded = store.load(&user).expect("load").expect("present");
        assert_eq!(loaded.password.expose(), "not-a-real-password");
        assert_eq!(loaded.history_key.expose(), "not-a-real-key");
        store.delete(&user).expect("delete");
        assert!(store.load(&user).expect("load after delete").is_none());
    }
}
