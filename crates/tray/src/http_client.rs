//! 极薄的本机回环 HTTP/1.1 客户端：只连 127.0.0.1，零外部依赖、不受系统代理影响。

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

fn send_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout: Duration,
) -> io::Result<HttpResponse> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;

    let payload = body.unwrap_or("");
    let req = if body.is_some() {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
    };
    stream.write_all(req.as_bytes())?;
    stream.flush()?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    let (head, resp_body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "HTTP 响应缺少头部分隔符"))?;
    let status_line = head.lines().next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "HTTP 状态行格式无效"))?;

    let decoded_body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        decode_chunked(resp_body)
    } else {
        resp_body.to_string()
    };

    Ok(HttpResponse {
        status,
        body: decoded_body,
    })
}

fn decode_chunked(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some((len_line, after_len)) = rest.split_once("\r\n") {
        let len_hex = len_line.split(';').next().unwrap_or("").trim();
        let Ok(len) = usize::from_str_radix(len_hex, 16) else {
            break;
        };
        if len == 0 || after_len.len() < len {
            break;
        }
        out.push_str(&after_len[..len]);
        rest = after_len[len..].strip_prefix("\r\n").unwrap_or(&after_len[len..]);
    }
    out
}

pub fn get(port: u16, path: &str, timeout: Duration) -> io::Result<HttpResponse> {
    send_request(port, "GET", path, None, timeout)
}

pub fn post_json(port: u16, path: &str, json_body: &str, timeout: Duration) -> io::Result<HttpResponse> {
    send_request(port, "POST", path, Some(json_body), timeout)
}
