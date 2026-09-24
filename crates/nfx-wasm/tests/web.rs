//! The bindings under a real JS engine (`wasm-pack test --node nfx-wasm`).

#![cfg(target_arch = "wasm32")]
#![allow(clippy::unwrap_used)]

use nfx_wasm::{
    VerifiedHashList, js_parse_a_tag, js_sha256_hex, js_verify_beacon, js_verify_manifest,
};
use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn bindings_verify_and_throw() {
    assert_eq!(
        js_sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let m: serde_json::Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
    assert!(js_verify_manifest(&m["event"].to_string()).is_ok());
    assert!(js_verify_manifest("{}").is_err());
    let b: serde_json::Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/beacon.json")).unwrap();
    let now = b["now"].as_f64().unwrap();
    assert!(js_verify_beacon(&b["event"].to_string(), now).is_ok());
    assert!(js_verify_beacon(&b["event"].to_string(), 1.5).is_err());
    assert!(VerifiedHashList::js_from_root(b"{}", &"0".repeat(64)).is_err());
    assert!(js_parse_a_tag("38504:x").is_err());
}
