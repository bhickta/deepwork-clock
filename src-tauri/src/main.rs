// The Windows release build must not open a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deepwork_clock_lib::run()
}
