/// Errors from reading Things Cloud. Reads are idempotent and may be retried.
#[derive(Debug, Clone, thiserror::Error, PartialEq)]
pub enum CloudError {
    #[error("Things Cloud rejected the email or password")]
    Unauthorized,
    #[error("Things Cloud is rate limiting this client (abuse prevention); try again later")]
    AbusePrevention,
    #[error("Things Cloud returned HTTP {status}{}", things_response.as_ref().map(|r| format!(" ({r})")).unwrap_or_default())]
    Http { status: u16, things_response: Option<String> },
    #[error("network error: {0}")]
    Network(String),
    #[error("could not decode Things Cloud response: {0}")]
    Decode(String),
    #[error("Things Cloud uses schema {found}, but this app only understands up to {supported}; update the app")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("protocol violation: {0}")]
    Protocol(String),
}

impl CloudError {
    /// Whether retrying the same read later could succeed.
    pub fn is_transient(&self) -> bool {
        match self {
            CloudError::Network(_) | CloudError::AbusePrevention => true,
            CloudError::Http { status, .. } => *status >= 500 || *status == 429,
            _ => false,
        }
    }
}

/// Outcome of a failed commit. The distinction matters: a rejected commit was
/// definitely not applied, an uncertain one may or may not have been.
/// **Neither is ever retried automatically.**
#[derive(Debug, Clone, thiserror::Error, PartialEq)]
pub enum CommitError {
    #[error("write rejected: {0}")]
    Rejected(CloudError),
    #[error("write outcome unknown: {0}")]
    Uncertain(String),
}
