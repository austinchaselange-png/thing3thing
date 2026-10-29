//! Windows shell integration: the `things:` URL scheme (so `things:///…` links
//! open this app, like Things on a Mac) and the taskbar jump list.

/// Collects `things:` links from a command line.
pub fn links_in(args: &[String]) -> Vec<String> {
    args.iter().filter(|a| a.to_ascii_lowercase().starts_with("things:")).cloned().collect()
}

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn reg(args: &[&str]) -> bool {
        Command::new("reg").args(args).creation_flags(CREATE_NO_WINDOW).output().map(|o| o.status.success()).unwrap_or(false)
    }

    /// Points HKCU\Software\Classes\things at this exe (per user, no admin).
    /// Leaves it alone when it already does, so nothing is rewritten on every launch.
    pub fn register_url_scheme() {
        let Ok(exe) = std::env::current_exe() else { return };
        let exe = exe.to_string_lossy().to_string();
        let command = format!("\"{exe}\" \"%1\"");
        let key = r"HKCU\Software\Classes\things\shell\open\command";
        let current = Command::new("reg")
            .args(["query", key, "/ve"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        if current.contains(&command) {
            return;
        }
        let ok = reg(&["add", r"HKCU\Software\Classes\things", "/ve", "/d", "URL:Things", "/f"])
            && reg(&["add", r"HKCU\Software\Classes\things", "/v", "URL Protocol", "/d", "", "/f"])
            && reg(&["add", key, "/ve", "/d", &command, "/f"]);
        if !ok {
            log::warn!("could not register the things: URL scheme");
        }
    }

    /// Right-click the taskbar icon: New To-Do, Today, Inbox, Upcoming, Quick Find.
    pub fn build_jump_list() -> windows::core::Result<()> {
        use windows::core::{Interface, HSTRING};
        use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
        use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
        use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
        use windows::Win32::UI::Shell::{DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink};

        let exe = std::env::current_exe().map_err(|_| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        let exe = HSTRING::from(exe.as_os_str());
        let tasks: [(&str, &str); 5] = [
            ("New To-Do", "things:///add?show-quick-entry=true"),
            ("Today", "things:///show?id=today"),
            ("Inbox", "things:///show?id=inbox"),
            ("Upcoming", "things:///show?id=upcoming"),
            ("Quick Find", "things:///search"),
        ];
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            let mut max = 0u32;
            let _removed: IObjectArray = list.BeginList(&mut max)?;
            let collection: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for (title, url) in tasks {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&exe)?;
                link.SetArguments(&HSTRING::from(format!("\"{url}\"")))?;
                link.SetIconLocation(&exe, 0)?;
                link.SetDescription(&HSTRING::from(title))?;
                let store: IPropertyStore = link.cast()?;
                store.SetValue(&PKEY_Title, &PROPVARIANT::from(title))?;
                store.Commit()?;
                collection.AddObject(&link)?;
            }
            let array: IObjectArray = collection.cast()?;
            list.AddUserTasks(&array)?;
            list.CommitList()?;
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::{build_jump_list, register_url_scheme};

#[cfg(not(windows))]
pub fn register_url_scheme() {}

#[cfg(not(windows))]
pub fn build_jump_list() -> Result<(), String> {
    Ok(())
}
