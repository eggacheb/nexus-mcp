//! 将面板 /api/status JSON 映射为托盘三色状态灯与菜单状态。

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LightColor {
    Green,
    Yellow,
    Red,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedStatus {
    pub color: LightColor,
    pub tooltip: String,
    pub tunnel_configured: bool,
    pub tunnel_running: bool,
}

#[derive(Debug, Deserialize)]
struct PanelStatusJson {
    service: ServiceJson,
    executor: ComponentJson,
    tunnel: TunnelJson,
}

#[derive(Debug, Deserialize)]
struct ServiceJson {
    state: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    port: u16,
}

#[derive(Debug, Deserialize)]
struct ComponentJson {
    state: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Deserialize)]
struct TunnelProcessJson {
    #[serde(default)]
    running: bool,
}

#[derive(Debug, Deserialize)]
struct TunnelJson {
    state: String,
    #[serde(default)]
    label: String,
    process: Option<TunnelProcessJson>,
}

/// 根据 /api/status 响应体计算三色状态灯与提示文案：
/// - 绿：服务运行中 + 执行器就绪 + 隧道已连接（up）
/// - 红：服务已停止 / 执行器异常（down）/ 隧道离线（down）
/// - 黄：启动中、隧道连接中（connecting）、未配置（unconfigured）或不可用（unavailable）
pub fn map_status_json(raw: &str, fallback_port: u16) -> MappedStatus {
    let Ok(parsed) = serde_json::from_str::<PanelStatusJson>(raw) else {
        return unreachable_status(fallback_port);
    };

    let service_ok = parsed.service.state == "running";
    let executor_ok = parsed.executor.state == "up";
    let tunnel_configured = parsed.tunnel.state != "unconfigured";
    let tunnel_running = parsed
        .tunnel
        .process
        .as_ref()
        .map(|p| p.running)
        .unwrap_or_else(|| parsed.tunnel.state == "up" || parsed.tunnel.state == "connecting");

    let color = if !service_ok
        || parsed.executor.state == "down"
        || parsed.tunnel.state == "down"
    {
        LightColor::Red
    } else if executor_ok && parsed.tunnel.state == "up" {
        LightColor::Green
    } else {
        LightColor::Yellow
    };

    let port = if parsed.service.port > 0 {
        parsed.service.port
    } else {
        fallback_port
    };
    let svc_label = if parsed.service.label.is_empty() {
        parsed.service.state.as_str()
    } else {
        parsed.service.label.as_str()
    };
    let tun_label = if parsed.tunnel.label.is_empty() {
        parsed.tunnel.state.as_str()
    } else {
        parsed.tunnel.label.as_str()
    };
    let exec_part = if parsed.executor.state == "up" {
        String::new()
    } else if !parsed.executor.label.is_empty() {
        format!(" · 执行器:{}", parsed.executor.label)
    } else {
        format!(" · 执行器:{}", parsed.executor.state)
    };

    MappedStatus {
        color,
        tooltip: format!("nexus-mcp :{port} · 服务:{svc_label} · 隧道:{tun_label}{exec_part}"),
        tunnel_configured,
        tunnel_running,
    }
}

pub fn unreachable_status(port: u16) -> MappedStatus {
    MappedStatus {
        color: LightColor::Red,
        tooltip: format!("nexus-mcp :{port} · 面板未响应"),
        tunnel_configured: false,
        tunnel_running: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_healthy_maps_to_green() {
        let json = r#"{
            "service": { "state": "running", "label": "运行中", "port": 8787 },
            "executor": { "state": "up", "label": "正常" },
            "tunnel": { "state": "up", "label": "已连接", "process": { "running": true } }
        }"#;
        let mapped = map_status_json(json, 8787);
        assert_eq!(mapped.color, LightColor::Green);
        assert!(mapped.tunnel_configured);
        assert!(mapped.tunnel_running);
        assert!(mapped.tooltip.contains("8787"));
        assert!(mapped.tooltip.contains("已连接"));
    }

    #[test]
    fn connecting_or_unconfigured_tunnel_maps_to_yellow() {
        let connecting = r#"{
            "service": { "state": "running", "label": "运行中", "port": 8787 },
            "executor": { "state": "up", "label": "正常" },
            "tunnel": { "state": "connecting", "label": "运行中", "process": { "running": true } }
        }"#;
        let m1 = map_status_json(connecting, 8787);
        assert_eq!(m1.color, LightColor::Yellow);
        assert!(m1.tunnel_configured);
        assert!(m1.tunnel_running);

        let unconfigured = r#"{
            "service": { "state": "running", "label": "运行中", "port": 8787 },
            "executor": { "state": "up", "label": "正常" },
            "tunnel": { "state": "unconfigured", "label": "未配置" }
        }"#;
        let m2 = map_status_json(unconfigured, 8787);
        assert_eq!(m2.color, LightColor::Yellow);
        assert!(!m2.tunnel_configured);
        assert!(!m2.tunnel_running);
    }

    #[test]
    fn stopped_service_or_down_tunnel_maps_to_red() {
        let down_tunnel = r#"{
            "service": { "state": "running", "label": "运行中", "port": 8787 },
            "executor": { "state": "up", "label": "正常" },
            "tunnel": { "state": "down", "label": "离线", "process": { "running": false } }
        }"#;
        let m1 = map_status_json(down_tunnel, 8787);
        assert_eq!(m1.color, LightColor::Red);
        assert!(m1.tunnel_configured);
        assert!(!m1.tunnel_running);

        let stopped_svc = r#"{
            "service": { "state": "stopped", "label": "已停止", "port": 8787 },
            "executor": { "state": "up", "label": "正常" },
            "tunnel": { "state": "up", "label": "已连接", "process": { "running": true } }
        }"#;
        let m2 = map_status_json(stopped_svc, 8787);
        assert_eq!(m2.color, LightColor::Red);
    }

    #[test]
    fn invalid_json_maps_to_red_unreachable() {
        let mapped = map_status_json("not-json", 8787);
        assert_eq!(mapped.color, LightColor::Red);
        assert!(mapped.tooltip.contains("未响应"));
    }
}
