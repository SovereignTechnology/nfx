//! Nostr keys on disk: one line of hex, mode 0600.
//!
//! The secret never reaches stdout, stderr or an error message; callers print the public
//! key only. A key file readable by group or others is refused, as ssh refuses one.
//!
//! Two ways in:
//! - [`load`] reads the file an operator named on the command line.
//! - [`KeyDir`] is a directory of creator keys the node owns, each named by its npub. A
//!   program that asks the node to sign names a key by npub, never by path, so it cannot
//!   point the node at some other readable key file.

use std::fs::{File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use nostr_sdk::prelude::{Keys, PublicKey, ToBech32 as _};
use rustix::fs::{Mode, OFlags};

use crate::{Error, Result};

/// The most keys a [`KeyDir`] holds.
pub const MAX_KEYS: usize = 16;

/// A key file is one line of 64 hex digits or an nsec; nothing honest is longer.
const MAX_KEY_FILE: u64 = 4096;

/// Generate a key and write it to `path`, which must not exist yet.
pub fn create(path: &Path) -> Result<Keys> {
    let keys = Keys::generate();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(keys.secret_key().to_secret_hex().as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(keys)
}

/// Load the key at `path`.
///
/// The mode is read from the open file, so the file checked is the file read.
pub fn load(path: &Path) -> Result<Keys> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(Error::Config(format!(
            "{}: not a regular file",
            path.display()
        )));
    }
    closed_to_others(path, meta.mode())?;
    parse(path, file)
}

fn closed_to_others(path: &Path, mode: u32) -> Result<()> {
    if mode & 0o077 != 0 {
        return Err(Error::Config(format!(
            "{}: key file is readable by group or others (mode {:o}); chmod 600 it",
            path.display(),
            mode & 0o777
        )));
    }
    Ok(())
}

fn parse(path: &Path, file: File) -> Result<Keys> {
    let mut text = String::new();
    file.take(MAX_KEY_FILE + 1).read_to_string(&mut text)?;
    if text.len() as u64 > MAX_KEY_FILE {
        return Err(Error::Config(format!(
            "{}: not a secret key",
            path.display()
        )));
    }
    Keys::parse(text.trim())
        .map_err(|_| Error::Config(format!("{}: not a secret key", path.display())))
}

/// A public key a user gave (an npub, or 64 hex digits) as 64 lowercase hex. The refusal
/// never repeats the input: it may be a secret key pasted by mistake, and an nsec is named
/// as one.
pub fn public_hex(v: &str) -> core::result::Result<String, &'static str> {
    let v = v.trim();
    let bare = v.strip_prefix("nostr:").unwrap_or(v);
    if bare.starts_with("nsec1") || bare.starts_with("ncryptsec1") {
        return Err("that is a secret key (nsec): give the npub, and keep the nsec to yourself");
    }
    PublicKey::parse(v)
        .map(|k| k.to_hex())
        .map_err(|_| "not an npub or a 64-hex public key")
}

/// The npub of a public key held as 64 hex digits.
pub fn npub(hex: &str) -> Option<String> {
    PublicKey::from_hex(hex).ok()?.to_bech32().ok()
}

/// A public key given as an npub, and only as one. Hex is refused: a secret key in hex
/// looks the same as a public one. The refusal never repeats the input.
pub fn npub_only(v: &str) -> core::result::Result<PublicKey, &'static str> {
    let v = v.trim();
    if v.starts_with("nsec1") || v.starts_with("ncryptsec1") {
        return Err("that is a secret key (nsec): give the npub, and keep the nsec to yourself");
    }
    if !v.starts_with("npub1") {
        return Err("not an npub");
    }
    PublicKey::parse(v).map_err(|_| "not an npub")
}

/// A directory of creator keys the node owns: `<npub>.key` files, mode 0600, in a
/// directory of mode 0700.
///
/// A key is named by its npub. [`KeyDir::load`] refuses a file that is a symlink, is not
/// a regular file, belongs to another user, is open to group or others, or does not hold
/// the key its name says.
#[derive(Debug, Clone)]
pub struct KeyDir {
    dir: PathBuf,
}

impl KeyDir {
    /// Open the key directory at `dir`, creating it (mode 0700) if it is not there. A
    /// directory that is a symlink, belongs to another user, or is open to group or
    /// others is refused.
    pub fn open(dir: &Path) -> Result<Self> {
        match std::fs::DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        // `symlink_metadata`: a symlink here is refused, not followed.
        let meta = std::fs::symlink_metadata(dir)?;
        let refuse = |why: &str| Error::Config(format!("{}: key directory {why}", dir.display()));
        if !meta.is_dir() {
            return Err(refuse("is not a directory (a symlink is refused)"));
        }
        if meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(refuse("belongs to another user"));
        }
        if meta.mode() & 0o077 != 0 {
            return Err(refuse("is open to group or others; chmod 700 it"));
        }
        Ok(Self {
            dir: dir.to_path_buf(),
        })
    }

    /// The npubs of the keys here, sorted. Read from the file names: no key is opened.
    /// A file whose name is not `<npub>.key` is not a key of this directory.
    pub fn list(&self) -> Result<Vec<String>> {
        let mut npubs = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let name = entry?.file_name();
            let Some(npub) = name.to_str().and_then(|n| n.strip_suffix(".key")) else {
                continue;
            };
            // Only a name that is exactly the npub of the key it parses to.
            if canonical(npub).as_deref() == Some(npub) {
                npubs.push(npub.to_owned());
            }
        }
        npubs.sort();
        Ok(npubs)
    }

    /// Make a key here and return its npub. Refused at [`MAX_KEYS`].
    pub fn create(&self) -> Result<String> {
        if self.list()?.len() >= MAX_KEYS {
            return Err(Error::Config(format!(
                "the key directory already holds {MAX_KEYS} keys"
            )));
        }
        let keys = Keys::generate();
        let npub = keys
            .public_key()
            .to_bech32()
            .map_err(|_| Error::Config("could not name the new key".into()))?;
        let path = self.path_of(&npub);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(keys.secret_key().to_secret_hex().as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        // The directory entry too, so the key survives a power cut once it is announced.
        File::open(&self.dir)?.sync_all()?;
        Ok(npub)
    }

    /// Load the key named `npub`. The error says what is wrong with the file, never what
    /// is in it.
    pub fn load(&self, npub: &str) -> Result<Keys> {
        let Some(npub) = canonical(npub) else {
            return Err(Error::Config("not an npub".into()));
        };
        let path = self.path_of(&npub);
        // NOFOLLOW: a symlink at the name is refused, so the file opened is in this
        // directory. NONBLOCK: a FIFO planted at the name returns at once instead of
        // blocking the node; it has no effect on a regular file.
        let fd = rustix::fs::open(
            &path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| {
            if e == rustix::io::Errno::NOENT {
                Error::Config("no such key".into())
            } else if e == rustix::io::Errno::LOOP {
                Error::Config(format!("{}: is a symlink", path.display()))
            } else {
                Error::Io(e.into())
            }
        })?;
        let file = File::from(fd);
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(Error::Config(format!(
                "{}: not a regular file",
                path.display()
            )));
        }
        if meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(Error::Config(format!(
                "{}: key file belongs to another user",
                path.display()
            )));
        }
        closed_to_others(&path, meta.mode())?;
        let keys = parse(&path, file)?;
        if keys.public_key().to_bech32().ok().as_deref() != Some(npub.as_str()) {
            return Err(Error::Config(format!(
                "{}: the key in this file is not the one its name says",
                path.display()
            )));
        }
        Ok(keys)
    }

    fn path_of(&self, npub: &str) -> PathBuf {
        self.dir.join(format!("{npub}.key"))
    }
}

/// `npub` as the node writes it, if it is one. The result is bech32 (lowercase letters and
/// digits only), so it is safe as a file name.
fn canonical(npub: &str) -> Option<String> {
    npub_only(npub).ok()?.to_bech32().ok()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nfxd-key-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn chmod(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn refusal(r: Result<Keys>) -> String {
        match r {
            Err(Error::Config(text)) => text,
            Err(e) => panic!("another error: {e}"),
            Ok(_) => panic!("loaded"),
        }
    }

    #[test]
    fn a_created_key_loads_and_is_private() {
        let d = scratch("create");
        let path = d.join("node.key");
        let made = create(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(load(&path).unwrap().public_key(), made.public_key());
        // It never overwrites.
        assert!(create(&path).is_err());
    }

    #[test]
    fn load_refuses_a_file_open_to_others_and_what_is_not_a_key() {
        let d = scratch("load");
        let path = d.join("node.key");
        create(&path).unwrap();
        for mode in [0o640, 0o604, 0o660, 0o644] {
            chmod(&path, mode);
            assert!(refusal(load(&path)).contains("readable by group or others"));
        }
        chmod(&path, 0o600);
        assert!(load(&path).is_ok());

        // A directory, an empty file, text that is no key, and a huge file.
        assert!(load(&d).is_err());
        let junk = d.join("junk.key");
        for body in [String::new(), "hello\n".into(), "f".repeat(100_000)] {
            std::fs::write(&junk, body).unwrap();
            chmod(&junk, 0o600);
            let text = refusal(load(&junk));
            assert!(text.ends_with("not a secret key"), "{text}");
            // The refusal names the file, never what is in it.
            assert!(!text.contains("hello") && !text.contains("ffff"), "{text}");
        }
    }

    #[test]
    fn load_follows_a_symlink_the_operator_named() {
        // The command line's --key may be a link (a credentials directory, say).
        let d = scratch("link");
        let path = d.join("real.key");
        let made = create(&path).unwrap();
        let link = d.join("link.key");
        std::os::unix::fs::symlink(path, &link).unwrap();
        assert_eq!(load(&link).unwrap().public_key(), made.public_key());
    }

    #[test]
    fn npub_only_takes_an_npub_and_nothing_else() {
        let keys = Keys::generate();
        let npub = keys.public_key().to_bech32().unwrap();
        assert_eq!(npub_only(&npub).unwrap(), keys.public_key());
        assert_eq!(
            npub_only(&format!("  {npub}\n")).unwrap(),
            keys.public_key()
        );
        // Hex, public or secret, is refused: the two look the same.
        assert!(npub_only(&keys.public_key().to_hex()).is_err());
        assert!(npub_only(&keys.secret_key().to_secret_hex()).is_err());
        let nsec = keys.secret_key().to_bech32().unwrap();
        let refusal = npub_only(&nsec).unwrap_err();
        assert!(refusal.contains("secret key"));
        assert!(!refusal.contains(&nsec));
        for junk in ["", "npub1", "npub1notakey", "nostr:npub1x", "NPUB1ABC"] {
            assert!(npub_only(junk).is_err(), "{junk}");
        }
    }

    #[test]
    fn a_key_directory_is_private_and_names_keys_by_npub() {
        let d = scratch("dir");
        let dir = d.join("creator-keys");
        let keys = KeyDir::open(&dir).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(keys.list().unwrap().is_empty());

        let a = keys.create().unwrap();
        let b = keys.create().unwrap();
        let mut want = vec![a.clone(), b.clone()];
        want.sort();
        assert_eq!(keys.list().unwrap(), want);
        assert_eq!(keys.load(&a).unwrap().public_key().to_bech32().unwrap(), a);
        let file = dir.join(format!("{a}.key"));
        assert_eq!(
            std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );

        // Opening it again changes nothing; a key that is not here is not found.
        let again = KeyDir::open(&dir).unwrap();
        assert_eq!(again.list().unwrap(), want);
        let other = Keys::generate().public_key().to_bech32().unwrap();
        assert_eq!(refusal(again.load(&other)), "no such key");
    }

    #[test]
    fn a_key_directory_refuses_what_it_does_not_own_outright() {
        let d = scratch("dir-refuse");
        // Open to group or others.
        let open = d.join("open");
        std::fs::create_dir(&open).unwrap();
        for mode in [0o750, 0o705, 0o755, 0o777] {
            chmod(&open, mode);
            let e = KeyDir::open(&open).unwrap_err().to_string();
            assert!(e.contains("open to group or others"), "{e}");
        }
        // A symlink to a good directory.
        let real = d.join("real");
        KeyDir::open(&real).unwrap();
        let link = d.join("link");
        std::os::unix::fs::symlink(real, &link).unwrap();
        let e = KeyDir::open(&link).unwrap_err().to_string();
        assert!(e.contains("symlink is refused"), "{e}");
        // A file.
        let file = d.join("file");
        std::fs::write(&file, b"").unwrap();
        assert!(KeyDir::open(&file).is_err());
    }

    #[test]
    fn a_key_directory_loads_only_the_file_its_name_promises() {
        let d = scratch("dir-load");
        let dir = d.join("creator-keys");
        let keys = KeyDir::open(&dir).unwrap();
        let a = keys.create().unwrap();
        let file = dir.join(format!("{a}.key"));

        // Open to others.
        chmod(&file, 0o644);
        assert!(refusal(keys.load(&a)).contains("readable by group or others"));
        chmod(&file, 0o600);

        // Another key under this name.
        let outside = d.join("other.key");
        let other = create(&outside).unwrap();
        std::fs::copy(&outside, &file).unwrap();
        chmod(&file, 0o600);
        let text = refusal(keys.load(&a));
        assert!(text.contains("not the one its name says"), "{text}");
        assert!(!text.contains(&other.secret_key().to_secret_hex()));

        // A symlink at the name, even to a good key: the node would be reading a file
        // outside its directory.
        std::fs::remove_file(file).unwrap();
        let other_npub = other.public_key().to_bech32().unwrap();
        let planted = dir.join(format!("{other_npub}.key"));
        std::os::unix::fs::symlink(outside, &planted).unwrap();
        assert!(refusal(keys.load(&other_npub)).contains("is a symlink"));
        // It is still listed by name: listing opens nothing.
        assert_eq!(keys.list().unwrap(), [other_npub.as_str()]);

        // A directory at the name.
        std::fs::remove_file(&planted).unwrap();
        std::fs::create_dir(planted).unwrap();
        assert!(keys.load(&other_npub).is_err());
    }

    #[test]
    fn a_key_directory_never_takes_a_path_for_a_name() {
        let d = scratch("dir-path");
        let dir = d.join("creator-keys");
        let keys = KeyDir::open(&dir).unwrap();
        let outside = d.join("outside.key");
        create(&outside).unwrap();
        for name in [
            "../outside",
            "/etc/passwd",
            "",
            ".",
            "..",
            "npub1/../../outside",
            "outside",
        ] {
            assert_eq!(refusal(keys.load(name)), "not an npub", "{name}");
        }
        // Files that are not named for an npub are not keys of the directory.
        for stem in ["x", "", "npub1bogus"] {
            std::fs::write(dir.join(format!("{stem}.key")), b"x").unwrap();
        }
        for name in ["notes.txt", "README"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert!(keys.list().unwrap().is_empty());
    }

    #[test]
    fn a_key_directory_stops_at_its_limit() {
        let d = scratch("dir-limit");
        let keys = KeyDir::open(&d.join("creator-keys")).unwrap();
        for _ in 0..MAX_KEYS {
            keys.create().unwrap();
        }
        assert_eq!(keys.list().unwrap().len(), MAX_KEYS);
        let e = keys.create().unwrap_err().to_string();
        assert!(e.contains("already holds"), "{e}");
        assert_eq!(keys.list().unwrap().len(), MAX_KEYS);
    }
}
