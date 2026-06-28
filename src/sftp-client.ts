import fs from 'fs';
import { Client } from 'ssh2';
import { InstanceConfig, SSHConfig } from './types';

export class SftpClientManager {
  private sshClients: Map<string, Client> = new Map();

  constructor() {}

  public async readFile(
    instanceName: string,
    config: InstanceConfig,
    filePath: string,
    encoding: 'utf8' | null = 'utf8'
  ): Promise<string | Buffer> {
    if (config.mode === 'local') {
      if (encoding === 'utf8') {
        return fs.promises.readFile(filePath, 'utf8');
      } else {
        return fs.promises.readFile(filePath);
      }
    }

    const command = `cat ${this.escapeShellArg(filePath)}`;
    if (encoding === 'utf8') {
      return this.executeSshCommand(instanceName, config.ssh!, command);
    } else {
      return this.executeSshCommandBinary(instanceName, config.ssh!, command);
    }
  }

  /**
   * Writes a file to either the local or remote filesystem.
   */
  public async writeFile(
    instanceName: string,
    config: InstanceConfig,
    filePath: string,
    content: string
  ): Promise<void> {
    if (config.mode === 'local') {
      const lastIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      const dir = filePath.substring(0, lastIndex);
      if (dir) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      return fs.promises.writeFile(filePath, content, 'utf8');
    }

    const lastSlash = filePath.lastIndexOf('/');
    const dir = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '';
    
    // Command to create folder if needed, then write stdin to file
    const command = dir 
      ? `mkdir -p ${this.escapeShellArg(dir)} && cat > ${this.escapeShellArg(filePath)}`
      : `cat > ${this.escapeShellArg(filePath)}`;

    await this.executeSshCommandWithStdin(instanceName, config.ssh!, command, content);
  }

  /**
   * Checks if a file/directory exists.
   */
  public async exists(instanceName: string, config: InstanceConfig, filePath: string): Promise<boolean> {
    if (config.mode === 'local') {
      try {
        await fs.promises.access(filePath);
        return true;
      } catch {
        return false;
      }
    }

    try {
      const command = `test -f ${this.escapeShellArg(filePath)} || test -d ${this.escapeShellArg(filePath)}`;
      await this.executeSshCommand(instanceName, config.ssh!, command);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes a file.
   */
  public async deleteFile(instanceName: string, config: InstanceConfig, filePath: string): Promise<void> {
    if (config.mode === 'local') {
      return fs.promises.unlink(filePath);
    }

    const command = `rm -f ${this.escapeShellArg(filePath)}`;
    await this.executeSshCommand(instanceName, config.ssh!, command);
  }

  /**
   * Disconnects all active SSH connections.
   */
  public disconnectAll(): void {
    for (const [name, client] of this.sshClients.entries()) {
      console.error(`[SSH] Disconnecting SSH client for instance ${name}`);
      client.end();
    }
    this.sshClients.clear();
  }

  /**
   * Resolves or connects to an SSH client connection.
   */
  private async getSshClient(instanceName: string, sshConfig: SSHConfig): Promise<Client> {
    let client = this.sshClients.get(instanceName);
    if (client) return client;

    console.error(`[SSH] Creating new SSH client connection for instance: ${instanceName}`);
    const newClient = new Client();

    const connPromise = new Promise<Client>((resolve, reject) => {
      newClient
        .on('ready', () => resolve(newClient))
        .on('error', (err) => reject(err))
        .connect({
          host: sshConfig.host,
          port: sshConfig.port || 22,
          username: sshConfig.user,
          privateKey: sshConfig.key 
            ? sshConfig.key 
            : sshConfig.keyPath 
              ? fs.readFileSync(sshConfig.keyPath) 
              : undefined,
          algorithms: sshConfig.algorithms
        });
    });

    const activeClient = await connPromise;
    this.sshClients.set(instanceName, activeClient);

    activeClient.on('close', () => {
      console.error(`[SSH] Connection closed for instance: ${instanceName}`);
      this.sshClients.delete(instanceName);
    });

    return activeClient;
  }

  /**
   * Helper to run an SSH command and capture stdout.
   */
  private async executeSshCommand(
    instanceName: string,
    sshConfig: SSHConfig,
    command: string
  ): Promise<string> {
    const client = await this.getSshClient(instanceName, sshConfig);

    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(`Command failed with exit code ${code}. Error: ${stderr.trim() || 'Unknown error'}`));
          }
        });
      });
    });
  }

  /**
   * Helper to run an SSH command and capture stdout as binary Buffer.
   */
  private async executeSshCommandBinary(
    instanceName: string,
    sshConfig: SSHConfig,
    command: string
  ): Promise<Buffer> {
    const client = await this.getSshClient(instanceName, sshConfig);

    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);

        const chunks: Buffer[] = [];
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          chunks.push(data);
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          if (code === 0) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error(`Command failed with exit code ${code}. Error: ${stderr.trim() || 'Unknown error'}`));
          }
        });
      });
    });
  }

  /**
   * Helper to run an SSH command feeding stdin content.
   */
  private async executeSshCommandWithStdin(
    instanceName: string,
    sshConfig: SSHConfig,
    command: string,
    stdinContent: string
  ): Promise<void> {
    const client = await this.getSshClient(instanceName, sshConfig);

    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stderr = '';

        // Consume stdout so the channel stream doesn't block when output buffer fills
        stream.on('data', (data: Buffer) => {
          // Discard stdout
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Command failed with exit code ${code}. Error: ${stderr.trim() || 'Unknown error'}`));
          }
        });

        // Write stdin content and close stream on next tick to ensure channel is ready
        process.nextTick(() => {
          stream.write(stdinContent, 'utf8');
          stream.end();
        });
      });
    });
  }

  /**
   * Escapes arguments to be safely passed in standard sh commands.
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}
