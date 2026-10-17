//! Things stores calendar dates (start date, deadline) as the Unix timestamp
//! of UTC midnight on that date. Timestamps (creation, modification,
//! completion) are fractional Unix seconds.

use chrono::{DateTime, NaiveDate, Utc};

pub fn date_to_wire(date: NaiveDate) -> i64 {
    date.and_hms_opt(0, 0, 0).expect("midnight is valid").and_utc().timestamp()
}

pub fn wire_to_date(ts: f64) -> Option<NaiveDate> {
    DateTime::<Utc>::from_timestamp(ts.floor() as i64, 0).map(|d| d.date_naive())
}

pub fn parse_ymd(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

pub fn format_ymd(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Current time as fractional Unix seconds (wire format for `cd`/`md`/`sp`).
pub fn now_ts() -> f64 {
    let now = Utc::now();
    now.timestamp() as f64 + f64::from(now.timestamp_subsec_micros()) / 1e6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_as_utc_midnight() {
        let d = NaiveDate::from_ymd_opt(2026, 2, 10).unwrap();
        // Value observed in a capture of the official client.
        assert_eq!(date_to_wire(d), 1770681600);
        assert_eq!(wire_to_date(1770681600.0), Some(d));
        assert_eq!(wire_to_date(1770681600.9), Some(d));
        assert_eq!(parse_ymd("2026-02-10"), Some(d));
        assert_eq!(format_ymd(d), "2026-02-10");
        assert!(parse_ymd("10/02/2026").is_none());
    }
}
