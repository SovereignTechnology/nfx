//! A directory only this user can enter: where the node keeps what no other user of the
//! machine may reach (its creator keys, its control socket).

use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _};
use std::path::Path;

use crate::{Error, Result};

/// Make sure `dir` is a directory of mode 0700 that this user owns, creating it if it is
/// not there (its parent must exist). `what` names it in a refusal ("key directory").
///
/// Refused: a symlink (it is not followed), anything that is not a directory, another
/// user's directory, and one open to group or others.
pub fn dir(dir: &Path, what: &str) -> Result<()> {
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    // `symlink_metadata`: a symlink here is refused, not followed.
    let meta = std::fs::symlink_metadata(dir)?;
    let refuse = |why: &str| Error::Config(format!("{}: {what} {why}", dir.display()));
    if !meta.is_dir() {
        return Err(refuse("is not a directory (a symlink is refused)"));
    }
    if meta.uid() != rustix::process::geteuid().as_raw() {
        return Err(refuse("belongs to another user"));
    }
    if meta.mode() & 0o077 != 0 {
        return Err(refuse("is open to group or others; chmod 700 it"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::PathBuf;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nfxd-private-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn it_makes_the_directory_private_and_takes_it_again() {
        let d = scratch("make").join("mine");
        dir(&d, "test directory").unwrap();
        assert_eq!(
            std::fs::metadata(&d).unwrap().permissions().mode() & 0o777,
            0o700
        );
        dir(&d, "test directory").unwrap();
        // Its parent is not made for it.
        assert!(dir(&d.join("a").join("b"), "test directory").is_err());
    }

    #[test]
    fn it_refuses_what_is_open_linked_or_not_a_directory() {
        let d = scratch("refuse");
        let open = d.join("open");
        std::fs::create_dir(&open).unwrap();
        for mode in [0o750, 0o705, 0o755, 0o777] {
            std::fs::set_permissions(&open, std::fs::Permissions::from_mode(mode)).unwrap();
            let e = dir(&open, "test directory").unwrap_err().to_string();
            assert!(
                e.contains("test directory is open to group or others"),
                "{e}"
            );
        }
        let real = d.join("real");
        dir(&real, "test directory").unwrap();
        let link = d.join("link");
        std::os::unix::fs::symlink(real, &link).unwrap();
        let e = dir(&link, "test directory").unwrap_err().to_string();
        assert!(e.contains("symlink is refused"), "{e}");
        let file = d.join("file");
        std::fs::write(&file, b"").unwrap();
        assert!(dir(&file, "test directory").is_err());
    }
}
