//! Read-only diagnostic tool for the Things Cloud connector.
//!
//! It never writes to Things Cloud. Use it to check that the connector can
//! read your account before trusting the desktop app with it.
//!
//!   things-cloud-cli verify  --email you@example.com
//!   things-cloud-cli summary --email you@example.com [--titles]
//!
//! The password is read from an interactive prompt (or THINGS_PASSWORD for
//! local scripting). It is not echoed, logged or stored.

use std::process::ExitCode;

use chrono::Local;
use things_cloud::http::HttpTransport;
use things_cloud::state::{Start, Status, TaskType};
use things_cloud::{Secret, State, Transport};

fn usage() -> ExitCode {
    eprintln!("usage: things-cloud-cli <verify|summary> --email <address> [--titles]");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().cloned() else { return usage() };
    let email = match args.iter().position(|a| a == "--email").and_then(|i| args.get(i + 1)) {
        Some(e) => e.clone(),
        None => return usage(),
    };
    let titles = args.iter().any(|a| a == "--titles");
    let password = match std::env::var("THINGS_PASSWORD") {
        Ok(p) if !p.is_empty() => Secret::new(p),
        _ => match rpassword::prompt_password(format!("Things Cloud password for {email}: ")) {
            Ok(p) => Secret::new(p),
            Err(e) => {
                eprintln!("could not read password: {e}");
                return ExitCode::FAILURE;
            }
        },
    };
    match run(&cmd, &email, &password, titles) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(cmd: &str, email: &str, password: &Secret, titles: bool) -> Result<(), String> {
    let t = HttpTransport::new().map_err(|e| e.to_string())?;
    let account = t.verify(email, password).map_err(|e| e.to_string())?;
    let head = t.history_head(&account.history_key).map_err(|e| e.to_string())?;
    println!("account:       {}", account.email);
    println!("status:        {}", account.status);
    println!("history key:   (fingerprint {})", account.history_key.fingerprint());
    println!("server index:  {}", head.latest_server_index);
    println!("schema:        {} (supported: {})", head.schema, things_cloud::SUPPORTED_SCHEMA);
    if cmd == "verify" {
        return Ok(());
    }
    if cmd != "summary" {
        return Err(format!("unknown command {cmd}"));
    }

    let mut state = State::new();
    let mut start = 0;
    loop {
        let page = t.items(&account.history_key, start).map_err(|e| e.to_string())?;
        state.apply_entries(page.start_index, &page.entries).map_err(|e| e.to_string())?;
        eprint!("\rpulled {} / {}", page.next_index(), page.current_item_index);
        if !page.has_more() {
            break;
        }
        start = page.next_index();
    }
    eprintln!();

    let today = Local::now().date_naive();
    let open: Vec<_> = state
        .tasks
        .values()
        .filter(|t| t.status == Status::Open && !t.trashed && !t.is_recurring_template() && t.task_type == TaskType::Task)
        .collect();
    let count = |f: &dyn Fn(&&things_cloud::state::Task) -> bool| open.iter().filter(|t| f(t)).count();
    println!("open to-dos:   {}", open.len());
    println!("  inbox:       {}", count(&|t| t.start == Start::Inbox));
    println!("  today:       {}", count(&|t| t.start != Start::Inbox && t.effective_start_date().is_some_and(|d| d <= today)));
    println!("  upcoming:    {}", count(&|t| t.effective_start_date().is_some_and(|d| d > today)));
    println!("  someday:     {}", count(&|t| t.start == Start::Someday && t.effective_start_date().is_none()));
    println!("projects:      {}", state.tasks.values().filter(|t| t.task_type == TaskType::Project && !t.trashed).count());
    println!("areas:         {}", state.areas.len());
    println!("tags:          {}", state.tags.len());
    println!("checklist:     {}", state.checklist.len());
    println!("repeating:     {}", state.tasks.values().filter(|t| t.is_recurring_template()).count());
    if state.newer_kinds.is_empty() {
        println!("data format:   validated kinds only (writes can be enabled)");
    } else {
        for (kind, count) in &state.newer_kinds {
            let fields: Vec<_> = state.unfamiliar_fields.get(kind).map(|f| f.iter().cloned().collect()).unwrap_or_default();
            println!(
                "newer format:  {kind} ×{count}; unfamiliar fields: {}",
                if fields.is_empty() { "none".into() } else { fields.join(", ") }
            );
        }
        println!("               Read best-effort. Writes are allowed (in this format) only when no unfamiliar fields are listed.");
    }
    if titles {
        for t in open.iter().filter(|t| t.start != Start::Inbox && t.effective_start_date().is_some_and(|d| d <= today)) {
            println!("  [today] {}", t.title);
        }
    }
    Ok(())
}
