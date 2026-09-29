import { invoke } from "@tauri-apps/api/core";

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
}

export interface ServerStatus {
  running: boolean;
  port: number;
  uptime_seconds: number;
  requests: number;
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
export const getAutostart = (): Promise<boolean> => invoke("get_autostart");
export const setAutostart = (enabled: boolean): Promise<boolean> => invoke("set_autostart", { enabled });
export const setStartHidden = (enabled: boolean): Promise<AppConfig> => invoke("set_start_hidden", { enabled });