//! 零外部依赖将 `assets/nexus-mcp.ico` 编译为标准 Win32 `.res` 资源并链接进 `nexus-mcp.exe`，
//! 让桌面快捷方式、资源管理器与任务栏都显示品牌图标（不依赖本机 PATH 里的 rc.exe）。

use std::env;
use std::fs;
use std::path::PathBuf;

const RT_ICON: u16 = 3;
const RT_GROUP_ICON: u16 = 14;

fn push_u16(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn pad4(buf: &mut Vec<u8>) {
    while !buf.len().is_multiple_of(4) {
        buf.push(0);
    }
}

fn write_res_entry(out: &mut Vec<u8>, res_type: u16, res_id: u16, data: &[u8]) {
    // Win32 .res RESOURCEHEADER（type 与 name 均为整数 ordinal：0xFFFF + u16，总头长 32 字节）
    push_u32(out, data.len() as u32); // DataSize
    push_u32(out, 32); // HeaderSize
    push_u16(out, 0xFFFF);
    push_u16(out, res_type);
    push_u16(out, 0xFFFF);
    push_u16(out, res_id);
    push_u32(out, 0); // DataVersion
    push_u16(out, 0x1030); // MemoryFlags (MOVEABLE | PURE | DISCARDABLE)
    push_u16(out, 0x0409); // LanguageId (en-US)
    push_u32(out, 0); // Version
    push_u32(out, 0); // Characteristics
    out.extend_from_slice(data);
    pad4(out);
}

fn ico_to_res(ico: &[u8]) -> Vec<u8> {
    assert!(ico.len() >= 6, "无效 ICO 文件：长度不足");
    let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
    assert!(ico.len() >= 6 + count * 16, "无效 ICO 文件：目录表截断");

    let mut res = Vec::with_capacity(ico.len() + 256);
    // Win32 32-bit .res 文件必须以空的 32 字节 0 号占位资源头开头
    write_res_entry(&mut res, 0, 0, &[]);

    let mut grp = Vec::with_capacity(6 + count * 14);
    push_u16(&mut grp, 0); // idReserved
    push_u16(&mut grp, 1); // idType (1 = icon)
    push_u16(&mut grp, count as u16);

    for i in 0..count {
        let base = 6 + i * 16;
        let bytes_in_res = u32::from_le_bytes([
            ico[base + 8],
            ico[base + 9],
            ico[base + 10],
            ico[base + 11],
        ]) as usize;
        let image_offset = u32::from_le_bytes([
            ico[base + 12],
            ico[base + 13],
            ico[base + 14],
            ico[base + 15],
        ]) as usize;
        let end = image_offset + bytes_in_res;
        assert!(end <= ico.len(), "无效 ICO 帧越界");

        let icon_id = (i + 1) as u16;
        write_res_entry(&mut res, RT_ICON, icon_id, &ico[image_offset..end]);

        // GRPICONDIRENTRY（前 12 字节与 ICONDIRENTRY 相同，后 2 字节为 nID）
        grp.extend_from_slice(&ico[base..base + 12]);
        push_u16(&mut grp, icon_id);
    }

    write_res_entry(&mut res, RT_GROUP_ICON, 1, &grp);
    res
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let ico_path = manifest_dir.join("..").join("..").join("assets").join("nexus-mcp.ico");
    println!("cargo:rerun-if-changed={}", ico_path.display());

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let ico = fs::read(&ico_path).expect("读取 assets/nexus-mcp.ico 失败");
    let res = ico_to_res(&ico);
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let res_path = out_dir.join("nexus-mcp.res");
    fs::write(&res_path, &res).expect("写入 nexus-mcp.res 失败");

    println!("cargo:rustc-link-arg-bin=nexus-mcp={}", res_path.display());
}
