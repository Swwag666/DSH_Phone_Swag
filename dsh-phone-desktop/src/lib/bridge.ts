import { invoke } from "@tauri-apps/api/core";

export interface DeviceEntry {
  name: string;
  token: string;
  connector_id: string;
}

export interface AppConfig {
  config_path: string;
  token: string;
  listen_host: string;
  listen_port: number;
  staging_path: string;
  tailscale_ip: string;
  connector_id: string;
  created_at_unix: number;
  start_hidden?: boolean;
  tls_enabled?: boolean;
  allowed_ips?: string[];
  devices?: DeviceEntry[];
}

export interface DeviceBrief {
  name: string;
  token: string;
  connector_id: string;
  connected: boolean;
  main: boolean;
}

export interface ServerStatus {
  running: boolean;
  port: number;
  uptime_seconds: number;
  requests: number;
  tls_sha256?: string | null;
  devices?: DeviceBrief[];
}

export interface TailscaleStatus {
  installed: boolean;
  logged_in: boolean;
  ip: string | null;
}

export const getConfig = (): Promise<AppConfig> => invoke("app_config");
export const regenerateToken = (): Promise<AppConfig> => invoke("regenerate_token");
export const serverStatus = (): Promise<ServerStatus> => invoke("server_status");
export const startServer = (): Promise<ServerStatus> => invoke("start_server");
export const stopServer = (): Promise<ServerStatus> => invoke("stop_server");
export const tailscaleStatus = (): Promise<TailscaleStatus> => invoke("tailscale_status");
export const tailscaleInstall = (): Promise<string> => invoke("tailscale_install");
export interface HealResult {
  ok: boolean;
  rebind: boolean;
  restun: boolean;
  ip: string;
}
export const healTailnet = (): Promise<HealResult> => invoke("heal_tailnet");
export const getAutostart = (): Promise<boolean> => invoke("get_autostart");
export const setAutostart = (enabled: boolean): Promise<boolean> => invoke("set_autostart", { enabled });
export const setStartHidden = (enabled: boolean): Promise<AppConfig> => invoke("set_start_hidden", { enabled });
export const setTlsEnabled = (enabled: boolean): Promise<AppConfig> => invoke("set_tls_enabled", { enabled });
export const setAllowedIps = (ips: string[]): Promise<AppConfig> => invoke("set_allowed_ips", { ips });
export const addDevice = (name: string): Promise<AppConfig> => invoke("add_device", { name });
export const removeDevice = (token: string): Promise<AppConfig> => invoke("remove_device", { token });