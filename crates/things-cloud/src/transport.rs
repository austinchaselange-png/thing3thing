use crate::{CloudError, CommitError, Item, Secret};

/// Result of verifying credentials.
#[derive(Debug, Clone)]
pub struct Account {
    pub email: String,
    pub history_key: Secret,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryHead {
    pub latest_server_index: u64,
    pub schema: u32,
}

/// A page of history. `entries[i]` is the server item at index
/// `start_index + i`; each entry holds one or more entity events.
#[derive(Debug, Clone)]
pub struct ItemsPage {
    pub start_index: u64,
    pub entries: Vec<Vec<Item>>,
    pub current_item_index: u64,
    pub schema: u32,
}

impl ItemsPage {
    pub fn next_index(&self) -> u64 {
        self.start_index + self.entries.len() as u64
    }

    pub fn has_more(&self) -> bool {
        !self.entries.is_empty() && self.next_index() < self.current_item_index
    }
}

/// The four Things Cloud operations Things 3 uses. Implemented by
/// [`crate::http::HttpTransport`] (real service) and [`crate::fake::FakeCloud`].
pub trait Transport: Send + Sync {
    fn verify(&self, email: &str, password: &Secret) -> Result<Account, CloudError>;
    fn history_head(&self, history_key: &Secret) -> Result<HistoryHead, CloudError>;
    fn items(&self, history_key: &Secret, start_index: u64) -> Result<ItemsPage, CloudError>;
    /// Appends one commit. Returns the new server head index, which must be
    /// `ancestor_index + 1`. Never retried by callers.
    fn commit(&self, history_key: &Secret, ancestor_index: u64, items: &[Item]) -> Result<u64, CommitError>;
}

/// Validates a page's cursor like the reference SDK so a misbehaving server
/// can never make the cursor skip or regress.
///
/// A newer schema number is *not* an error here: items are checked one by
/// one when applied, so reading keeps working. Writers must refuse to write
/// while the server reports a newer schema (see `things_sync::Engine`).
pub fn validate_page(page: &ItemsPage) -> Result<(), CloudError> {
    if page.current_item_index < page.start_index {
        return Err(CloudError::Protocol(format!("server cursor regressed from {} to {}", page.start_index, page.current_item_index)));
    }
    if page.entries.is_empty() && page.start_index < page.current_item_index {
        return Err(CloudError::Protocol(format!(
            "server returned no items at index {} although head is {}",
            page.start_index, page.current_item_index
        )));
    }
    if page.next_index() > page.current_item_index {
        return Err(CloudError::Protocol(format!("page ends at {} beyond server head {}", page.next_index(), page.current_item_index)));
    }
    Ok(())
}
