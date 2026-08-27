fn main() {
    // Vite emits content-hashed file names, so watching only previously known
    // files can leave an incremental desktop build with stale embedded assets.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
