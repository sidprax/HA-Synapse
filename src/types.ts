export interface SSHConfig {
  host: string;
  port?: number;
  user: string;
  keyPath?: string;
  key?: string; // Inline private key content
  algorithms?: any; // Custom SSH algorithms config
}

export interface InstanceConfig {
  url: string;
  token: string;
  mode: 'local' | 'ssh';
  remoteConfigDir?: string; // Path on remote (e.g. "/homeassistant" or "/config")
  localConfigDir?: string;  // Path on local (e.g. "/config" or relative path)
  ssh?: SSHConfig;
  backupEnabled?: boolean; // Whether to keep persistent backups in .mcp_backups
}

export interface HASynapseConfig {
  defaultInstance?: string;
  instances: Record<string, InstanceConfig>;
}

export interface HAEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

export interface HAService {
  name?: string;
  description: string;
  fields: Record<string, {
    description: string;
    example?: any;
    selector?: Record<string, any>;
    required?: boolean;
    default?: any;
  }>;
  target?: any;
}

export interface HAServiceDomain {
  domain: string;
  services: Record<string, HAService>;
}
