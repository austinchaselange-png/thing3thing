//! HTTP transport for the real Things Cloud service.
//!
//! Security notes:
//! * the password is sent only to the verify endpoint, only over HTTPS;
//! * the history key is a bearer secret embedded in URL paths, so every error
//!   message is built without the URL (`reqwest::Error::without_url`) and
//!   nothing here logs requests or responses;
//! * requests are limited to one per second, like the reference SDK.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::StatusCode;
use serde_json::{json, Value};

use crate::transport::{validate_page, Account, HistoryHead, ItemsPage, Transport};
use crate::wire::{commit_body, parse_entry};
use crate::{CloudError, CommitError, Item, Secret, SUPPORTED_SCHEMA};

pub const DEFAULT_ENDPOINT: &str = "https://cloud.culturedcode.com";

/// The reference SDK identifies as Things for Mac; the service may depend on
/// these values. Kept in one place so they can be changed if needed.
const USER_AGENT: &str = "ThingsMac/32209501";
const APP_ID: &str = "com.culturedcode.ThingsMac";
const APP_INSTANCE_ID: &str = "000000000000000000000000000000000000000000000000000000000000000-com.culturedcode.ThingsMac-000000000000000000000000000000000000000000000000000000000000000";

pub struct HttpTransport {
    endpoint: String,
    client: Client,
    min_interval: Duration,
    last_request: Mutex<Option<Instant>>,
    client_info: String,
}

impl HttpTransport {
    pub fn new() -> Result<Self, CloudError> {
        Self::with_endpoint(DEFAULT_ENDPOINT, Duration::from_secs(1), Duration::from_secs(30))
    }

    /// Custom endpoint and timing; used by tests against a local mock server.
    pub fn with_endpoint(endpoint: &str, min_interval: Duration, timeout: Duration) -> Result<Self, CloudError> {
        let client = Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(15))
            .https_only(endpoint.starts_with("https://"))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| CloudError::Network(e.without_url().to_string()))?;
        let info = json!({
            "dm": "MacBookPro18,3", "lr": "US", "nf": true, "nk": true, "nn": "ThingsMac",
            "nv": "32209501", "on": "macOS", "ov": "15.7.3", "pl": "en-US", "ul": "en-Latn-US",
        });
        Ok(HttpTransport {
            endpoint: endpoint.trim_end_matches('/').to_string(),
            client,
            min_interval,
            last_request: Mutex::new(None),
            client_info: base64::engine::general_purpose::STANDARD.encode(info.to_string()),
        })
    }

    fn throttle(&self) {
        let mut last = self.last_request.lock().unwrap();
        if let Some(prev) = *last {
            let elapsed = prev.elapsed();
            if elapsed < self.min_interval {
                std::thread::sleep(self.min_interval - elapsed);
            }
        }
        *last = Some(Instant::now());
    }

    fn request(&self, method: reqwest::Method, path: &str) -> RequestBuilder {
        self.throttle();
        self.client
            .request(method, format!("{}{}", self.endpoint, path))
            .header("Accept", "application/json")
            .header("Accept-Charset", "UTF-8")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Things-Client-Info", &self.client_info)
    }

    fn history_path(key: &Secret) -> String {
        format!("/version/1/history/{}", encode_segment(key.expose()))
    }
}

/// Percent-encodes a path segment, leaving characters Things clients send raw.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~@+".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn status_error(resp: &Response) -> CloudError {
    let things_response = resp.headers().get("Things-Response").and_then(|v| v.to_str().ok()).map(str::to_string);
    match resp.status() {
        StatusCode::UNAUTHORIZED => CloudError::Unauthorized,
        StatusCode::TOO_MANY_REQUESTS if things_response.as_deref() == Some("AbusePrevention") => CloudError::AbusePrevention,
        s => CloudError::Http { status: s.as_u16(), things_response },
    }
}

fn network_error(e: reqwest::Error) -> CloudError {
    CloudError::Network(e.without_url().to_string())
}

fn read_json(resp: Response) -> Result<Value, CloudError> {
    if !resp.status().is_success() {
        return Err(status_error(&resp));
    }
    let bytes = resp.bytes().map_err(network_error)?;
    serde_json::from_slice(&bytes).map_err(|e| CloudError::Decode(e.to_string()))
}

fn as_index(v: &Value, key: &str) -> Result<u64, CloudError> {
    v.get(key).and_then(Value::as_u64).ok_or_else(|| CloudError::Decode(format!("missing {key}")))
}

fn schema_of(v: &Value) -> u32 {
    let s = v.get("schema").and_then(Value::as_u64).filter(|s| *s != 0);
    s.or_else(|| v.get("latest-schema-version").and_then(Value::as_u64)).unwrap_or(0) as u32
}

impl Transport for HttpTransport {
    fn verify(&self, email: &str, password: &Secret) -> Result<Account, CloudError> {
        let resp = self
            .request(reqwest::Method::GET, &format!("/version/1/account/{}", encode_segment(email)))
            .header("Authorization", format!("Password {}", password.expose()))
            .send()
            .map_err(network_error)?;
        let v = read_json(resp)?;
        let key = v
            .get("history-key")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CloudError::Decode("account response has no history key".into()))?;
        Ok(Account {
            email: v.get("email").and_then(Value::as_str).unwrap_or(email).to_string(),
            history_key: Secret::new(key),
            status: v.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    }

    fn history_head(&self, key: &Secret) -> Result<HistoryHead, CloudError> {
        let resp = self.request(reqwest::Method::GET, &Self::history_path(key)).send().map_err(network_error)?;
        let v = read_json(resp)?;
        let head = HistoryHead {
            latest_server_index: as_index(&v, "latest-server-index")?,
            schema: v.get("latest-schema-version").and_then(Value::as_u64).unwrap_or(0) as u32,
        };
        Ok(head)
    }

    fn items(&self, key: &Secret, start_index: u64) -> Result<ItemsPage, CloudError> {
        let resp = self
            .request(reqwest::Method::GET, &format!("{}/items", Self::history_path(key)))
            .query(&[("start-index", start_index.to_string())])
            .send()
            .map_err(network_error)?;
        let v = read_json(resp)?;
        let raw = v.get("items").and_then(Value::as_array).ok_or_else(|| CloudError::Decode("missing items".into()))?;
        let mut entries = Vec::with_capacity(raw.len());
        for entry in raw {
            entries.push(parse_entry(entry).map_err(CloudError::Decode)?);
        }
        let page = ItemsPage { start_index, entries, current_item_index: as_index(&v, "current-item-index")?, schema: schema_of(&v) };
        validate_page(&page)?;
        Ok(page)
    }

    fn commit(&self, key: &Secret, ancestor_index: u64, items: &[Item]) -> Result<u64, CommitError> {
        if items.is_empty() {
            return Err(CommitError::Rejected(CloudError::Protocol("empty commit".into())));
        }
        let body = commit_body(items).to_string();
        let result = self
            .request(reqwest::Method::POST, &format!("{}/commit", Self::history_path(key)))
            .query(&[("ancestor-index", ancestor_index.to_string()), ("_cnt", "1".to_string())])
            .header("Content-Type", "application/json; charset=UTF-8")
            .header("Content-Encoding", "UTF-8")
            .header("Schema", SUPPORTED_SCHEMA.to_string())
            .header("Push-Priority", "5")
            .header("App-Id", APP_ID)
            .header("App-Instance-Id", APP_INSTANCE_ID)
            .body(body)
            .send();
        let resp = match result {
            Ok(r) => r,
            // No connection was made, so the request cannot have been processed.
            Err(e) if e.is_connect() => return Err(CommitError::Rejected(network_error(e))),
            // Timeouts and broken connections may happen after the server got the body.
            Err(e) => return Err(CommitError::Uncertain(network_error(e).to_string())),
        };
        let status = resp.status();
        if status.is_server_error() {
            // A 5xx may come from a proxy after the commit was stored.
            return Err(CommitError::Uncertain(status_error(&resp).to_string()));
        }
        if !status.is_success() {
            return Err(CommitError::Rejected(status_error(&resp)));
        }
        let bytes = resp.bytes().map_err(|e| CommitError::Uncertain(network_error(e).to_string()))?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|e| CommitError::Uncertain(format!("unreadable commit response: {e}")))?;
        v.get("server-head-index")
            .and_then(Value::as_u64)
            .ok_or_else(|| CommitError::Uncertain("commit response has no server-head-index".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;
    use std::net::TcpListener;

    const KEY: &str = "secret-history-key-123";

    fn transport(server: &mockito::Server) -> HttpTransport {
        HttpTransport::with_endpoint(&server.url(), Duration::ZERO, Duration::from_secs(5)).unwrap()
    }

    fn key() -> Secret {
        Secret::new(KEY)
    }

    #[test]
    fn verify_sends_password_only_in_header() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("GET", "/version/1/account/me+test@example.com")
            .match_header("authorization", "Password pa ss")
            .match_header("user-agent", USER_AGENT)
            .match_header("things-client-info", Matcher::Any)
            .with_body(r#"{"history-key":"HK","email":"me+test@example.com","status":"SYAccountStatusActive"}"#)
            .create();
        let acct = transport(&server).verify("me+test@example.com", &Secret::new("pa ss")).unwrap();
        m.assert();
        assert_eq!(acct.history_key.expose(), "HK");

        server.mock("GET", "/version/1/account/bad@example.com").with_status(401).create();
        assert_eq!(transport(&server).verify("bad@example.com", &Secret::new("x")).unwrap_err(), CloudError::Unauthorized);
    }

    #[test]
    fn items_are_parsed_and_validated() {
        let mut server = mockito::Server::new();
        server
            .mock("GET", format!("/version/1/history/{KEY}/items").as_str())
            .match_query(Matcher::UrlEncoded("start-index".into(), "0".into()))
            .with_body(r#"{"items":[{"A":{"t":0,"e":"Area3","p":{"tt":"Home"}}},{"B":{"t":0,"e":"Tag4","p":{"tt":"x"}},"C":{"t":2,"e":"Tag4","p":{}}}],"current-item-index":2,"schema":301}"#)
            .create();
        let page = transport(&server).items(&key(), 0).unwrap();
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.entries[1].len(), 2);
        assert!(!page.has_more());

        server
            .mock("GET", format!("/version/1/history/{KEY}/items").as_str())
            .match_query(Matcher::UrlEncoded("start-index".into(), "5".into()))
            .with_body(r#"{"items":[],"current-item-index":9,"schema":301}"#)
            .create();
        assert!(matches!(transport(&server).items(&key(), 5), Err(CloudError::Protocol(_))));

        server
            .mock("GET", format!("/version/1/history/{KEY}/items").as_str())
            .match_query(Matcher::UrlEncoded("start-index".into(), "7".into()))
            .with_body(r#"{"items":[],"current-item-index":7,"schema":302}"#)
            .create();
        // A newer schema is still read; the engine blocks writes instead.
        assert_eq!(transport(&server).items(&key(), 7).unwrap().schema, 302);
    }

    #[test]
    fn abuse_prevention_is_recognised() {
        let mut server = mockito::Server::new();
        server
            .mock("GET", format!("/version/1/history/{KEY}").as_str())
            .with_status(429)
            .with_header("Things-Response", "AbusePrevention")
            .create();
        let err = transport(&server).history_head(&key()).unwrap_err();
        assert_eq!(err, CloudError::AbusePrevention);
        assert!(err.is_transient());
    }

    #[test]
    fn commit_request_shape() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", format!("/version/1/history/{KEY}/commit").as_str())
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("ancestor-index".into(), "41".into()),
                Matcher::UrlEncoded("_cnt".into(), "1".into()),
            ]))
            .match_header("schema", "301")
            .match_header("app-id", APP_ID)
            .match_header("authorization", Matcher::Missing)
            .match_body(Matcher::Json(json!({"X": {"t": 1, "e": "Task6", "p": {"tt": "Hi"}}})))
            .with_body(r#"{"server-head-index":42}"#)
            .create();
        let head = transport(&server).commit(&key(), 41, &[Item::new("X", "Task6", 1, json!({"tt":"Hi"}))]).unwrap();
        m.assert();
        assert_eq!(head, 42);
    }

    #[test]
    fn commit_failures_are_classified() {
        let item = [Item::new("X", "Task6", 1, json!({}))];
        let mut server = mockito::Server::new();
        let path = format!("/version/1/history/{KEY}/commit");
        let t = transport(&server);

        let m = server.mock("POST", path.as_str()).match_query(Matcher::Any).with_status(400).create();
        assert!(matches!(t.commit(&key(), 0, &item), Err(CommitError::Rejected(CloudError::Http { status: 400, .. }))));
        m.remove();
        let m = server.mock("POST", path.as_str()).match_query(Matcher::Any).with_status(502).create();
        assert!(matches!(t.commit(&key(), 0, &item), Err(CommitError::Uncertain(_))));
        m.remove();
        let m = server.mock("POST", path.as_str()).match_query(Matcher::Any).with_body("not json").create();
        assert!(matches!(t.commit(&key(), 0, &item), Err(CommitError::Uncertain(_))));
        m.remove();

        // Nothing listening: the request never left, so it is a definite failure.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = closed.local_addr().unwrap();
        drop(closed);
        // Windows retries refused connections for ~2 s, so allow longer than
        // that; a timeout here would (correctly, conservatively) be "uncertain".
        let t = HttpTransport::with_endpoint(&format!("http://{addr}"), Duration::ZERO, Duration::from_secs(10)).unwrap();
        match t.commit(&key(), 0, &item) {
            Err(CommitError::Rejected(CloudError::Network(msg))) => assert!(!msg.contains(KEY), "{msg}"),
            other => panic!("unexpected {other:?}"),
        }

        // Server accepts the body but never answers: outcome unknown.
        let hang = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = hang.local_addr().unwrap();
        let _guard = std::thread::spawn(move || {
            let (_s, _) = hang.accept().unwrap();
            std::thread::sleep(Duration::from_secs(3));
        });
        let t = HttpTransport::with_endpoint(&format!("http://{addr}"), Duration::ZERO, Duration::from_millis(500)).unwrap();
        match t.commit(&key(), 0, &item) {
            Err(CommitError::Uncertain(msg)) => assert!(!msg.contains(KEY), "history key leaked: {msg}"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn path_segments_are_encoded() {
        assert_eq!(encode_segment("a b/c?d@e+f"), "a%20b%2Fc%3Fd@e+f");
    }
}
