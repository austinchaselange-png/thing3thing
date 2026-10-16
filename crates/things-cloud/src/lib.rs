//! Local connector for the unofficial Things Cloud sync protocol.
//!
//! The protocol is reverse-engineered (see `docs/THINGS_CLOUD_RESEARCH.md`).
//! Payload shapes mirror `wbopan/things-cloud-mcp`, which has been validated
//! against Things.app; do not change field values without a capture proving
//! the official clients accept them.

pub mod dates;
pub mod error;
pub mod fake;
#[cfg(feature = "http")]
pub mod http;
pub mod id;
pub mod note;
pub mod ops;
pub mod recurrence;
pub mod secret;
pub mod state;
pub mod transport;
pub mod wire;

pub use error::{CloudError, CommitError};
pub use secret::Secret;
pub use state::State;
pub use transport::{Account, HistoryHead, ItemsPage, Transport};
pub use wire::Item;

/// Highest Things Cloud schema this connector understands. Reads and writes
/// fail closed when the server reports a newer schema.
pub const SUPPORTED_SCHEMA: u32 = 301;
