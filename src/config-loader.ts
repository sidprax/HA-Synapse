import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { HASynapseConfig, InstanceConfig } from './types';

// Load local dotenv in case it is run directly/tested
dotenv.config();

const DEFAULT_CONFIG_FILENAME = '.ha-synapse.json';

export class ConfigLoader {
  private config: HASynapseConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  public getConfig(): HASynapseConfig {
    return this.config;
  }

  public getInstance(name?: string): InstanceConfig {
    const instanceName = name || this.config.defaultInstance || 'default';
    const instance = this.config.instances[instanceName];
    if (!instance) {
      throw new Error(
        `Home Assistant instance "${instanceName}" not found in configuration. Available instances: ${Object.keys(
          this.config.instances
        ).join(', ')}`
      );
    }
    return instance;
  }

  private loadConfig(): HASynapseConfig {
    // 1. Check custom path env variable
    const customPath = process.env.HA_MCP_CONFIG_PATH;
    let configPath = '';

    if (customPath) {
      configPath = path.resolve(customPath);
    } else {
      configPath = path.join(os.homedir(), DEFAULT_CONFIG_FILENAME);
    }

    if (fs.existsSync(configPath)) {
      try {
        console.error(`[Config] Loading configuration from ${configPath}`);
        const fileContent = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(fileContent) as HASynapseConfig;
        
        if (!parsed.instances || Object.keys(parsed.instances).length === 0) {
          throw new Error('No instances defined in configuration file.');
        }

        // Set default instance if not specified
        if (!parsed.defaultInstance) {
          parsed.defaultInstance = Object.keys(parsed.instances)[0];
        }

        return parsed;
      } catch (err: any) {
        console.error(`[Config] Error reading config file at ${configPath}:`, err.message);
      }
    }

    // 2. Fallback to Environment Variables
    console.error('[Config] Configuration file not found. Falling back to environment variables.');
    const haUrl = process.env.HA_URL;
    const haToken = process.env.HA_TOKEN;

    if (haUrl && haToken) {
      const mode = (process.env.HA_MODE as 'local' | 'ssh') || (process.env.SSH_HOST ? 'ssh' : 'local');
      const defaultInstance: InstanceConfig = {
        url: haUrl,
        token: haToken,
        mode,
        remoteConfigDir: process.env.HA_REMOTE_DIR || '/homeassistant',
        localConfigDir: process.env.HA_LOCAL_DIR || './',
      };

      if (mode === 'ssh' && process.env.SSH_HOST) {
        defaultInstance.ssh = {
          host: process.env.SSH_HOST,
          port: process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22,
          user: process.env.SSH_USER || 'root',
          keyPath: process.env.SSH_KEY_PATH,
        };
      }

      return {
        defaultInstance: 'default',
        instances: {
          default: defaultInstance,
        },
      };
    }

    // 3. No configuration found
    throw new Error(
      `No Home Assistant configuration found. Please create a "${DEFAULT_CONFIG_FILENAME}" file in your home directory (${os.homedir()}) or set HA_URL and HA_TOKEN environment variables.`
    );
  }
}
