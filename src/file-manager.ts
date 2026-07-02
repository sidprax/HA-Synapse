import { SftpClientManager } from './sftp-client';
import { InstanceConfig } from './types';
import { resolveSafePath, validateYaml } from './utils';
import { HAClient } from './ha-client';

export class FileManager {
  private sftpManager: SftpClientManager;

  constructor(sftpManager: SftpClientManager) {
    this.sftpManager = sftpManager;
  }

  /**
   * Reads a file within the instance's sandboxed configuration directory.
   */
  public async readFile(
    instanceName: string,
    config: InstanceConfig,
    relativePath: string,
    encoding: 'utf8' | null = 'utf8'
  ): Promise<string | Buffer> {
    const rootDir = this.getConfigDir(config);
    const isRemote = config.mode === 'ssh';
    const absolutePath = resolveSafePath(rootDir, relativePath, isRemote);

    const exists = await this.sftpManager.exists(instanceName, config, absolutePath);
    if (!exists) {
      throw new Error(`File does not exist: ${relativePath}`);
    }

    return this.sftpManager.readFile(instanceName, config, absolutePath, encoding);
  }

  /**
   * Checks if a file exists within the sandbox.
   */
  public async exists(
    instanceName: string,
    config: InstanceConfig,
    relativePath: string
  ): Promise<boolean> {
    const rootDir = this.getConfigDir(config);
    const isRemote = config.mode === 'ssh';
    const absolutePath = resolveSafePath(rootDir, relativePath, isRemote);
    return this.sftpManager.exists(instanceName, config, absolutePath);
  }

  /**
   * Writes a file within the instance's sandbox.
   * If it is a YAML file, it validates the syntax locally, takes a backup, validates configuration
   * against the HA instance, and rolls back automatically if configuration check fails.
   */
  public async writeFile(
    instanceName: string,
    config: InstanceConfig,
    haClient: HAClient,
    relativePath: string,
    content: string
  ): Promise<void> {
    const rootDir = this.getConfigDir(config);
    const isRemote = config.mode === 'ssh';
    const absolutePath = resolveSafePath(rootDir, relativePath, isRemote);

    const isYaml = relativePath.endsWith('.yaml') || relativePath.endsWith('.yml');

    // 1. Local YAML Syntax Check
    if (isYaml) {
      const lint = validateYaml(content);
      if (!lint.isValid) {
        throw new Error(`YAML Syntax Error: ${lint.error}`);
      }
    }

    // 2. Determine if original file exists to prepare backup
    const fileExists = await this.sftpManager.exists(instanceName, config, absolutePath);
    let originalContent: string | null = null;
    let backupPath: string | null = null;

    if (fileExists) {
      originalContent = await this.sftpManager.readFile(instanceName, config, absolutePath, 'utf8') as string;
      
      if (config.backupEnabled !== false) {
        // Create backup file inside .mcp_backups
        const timestamp = Date.now();
        const sanitizedName = relativePath.replace(/[\/\\]/g, '_');
        backupPath = resolveSafePath(rootDir, `.mcp_backups/${sanitizedName}.${timestamp}.bak`, isRemote);
        
        await this.sftpManager.writeFile(instanceName, config, backupPath, originalContent);
        console.error(`[FileManager][${instanceName}] Backup created at ${backupPath}`);
      }
    }

    try {
      // 3. Write new content
      await this.sftpManager.writeFile(instanceName, config, absolutePath, content);
      console.error(`[FileManager][${instanceName}] File written to ${relativePath}`);

      // 4. HA Configuration Check (only for YAML files)
      if (isYaml) {
        console.error(`[FileManager][${instanceName}] Running Home Assistant configuration check...`);
        const check = await haClient.checkConfig();
        
        if (check.errors) {
          console.error(`[FileManager][${instanceName}] HA config check FAILED: ${check.errors}`);
          
          // Trigger Rollback
          if (fileExists && originalContent !== null) {
            console.error(`[FileManager][${instanceName}] Rolling back to original content...`);
            await this.sftpManager.writeFile(instanceName, config, absolutePath, originalContent);
          } else {
            // Delete the file if it didn't exist before
            console.error(`[FileManager][${instanceName}] Rolling back by deleting new file...`);
            await this.sftpManager.deleteFile(instanceName, config, absolutePath);
          }

          throw new Error(`Home Assistant Configuration Validation Failed: ${check.errors}`);
        } else {
          console.error(`[FileManager][${instanceName}] HA config check PASSED!`);
        }
      }

    } catch (err: any) {
      // Re-throw if it's already a config check error
      if (err.message.startsWith('Home Assistant Configuration Validation Failed') || err.message.startsWith('YAML Syntax Error')) {
        throw err;
      }

      // If network or disk error during write, try to restore from backup
      if (fileExists && originalContent !== null) {
        try {
          await this.sftpManager.writeFile(instanceName, config, absolutePath, originalContent);
        } catch (rollbackErr: any) {
          console.error(`[FileManager][${instanceName}] Failed to write rollback:`, rollbackErr.message);
        }
      }
      throw new Error(`Write failed: ${err.message}`);
    }
  }

  private getConfigDir(config: InstanceConfig): string {
    if (config.mode === 'local') {
      return config.localConfigDir || './';
    } else {
      return config.remoteConfigDir || '/homeassistant';
    }
  }
}
