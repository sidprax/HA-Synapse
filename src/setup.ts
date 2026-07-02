import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import { execSync } from 'child_process';
import { Client } from 'ssh2';
import { HASynapseConfig, InstanceConfig, SSHConfig } from './types';

// Standard SSH algorithm presets for auto-probing
const ALGORITHM_PRESETS = [
  undefined,
  { mac: ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com'] },
  {
    kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'diffie-hellman-group14-sha256'],
    cipher: ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'],
    mac: ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512', 'hmac-sha2-256']
  }
];

async function runSetup() {
  const rl = readline.createInterface({ input, output });
  console.log('======================================================');
  console.log('🧠 HA Synapse - Guided Installation & Setup Wizard');
  console.log('======================================================\n');

  try {
    const instanceName = await rl.question('1. Enter Home Assistant instance name (default: home): ') || 'home';
    let haUrl = await rl.question('2. Enter Home Assistant URL (e.g. http://10.0.2.52:8123): ');
    if (!haUrl) throw new Error('Home Assistant URL is required.');
    haUrl = haUrl.trim().replace(/\/$/, '');

    const haToken = await rl.question('3. Enter your Home Assistant Long-Lived Access Token: ');
    if (!haToken) throw new Error('Long-Lived Access Token is required.');

    const modeInput = await rl.question('4. Enter connection mode (local / ssh) [default: ssh]: ');
    const mode = (modeInput.toLowerCase() === 'local') ? 'local' : 'ssh';

    const backupInput = await rl.question('5. Enable persistent backups of configuration changes? (y/n) [default: y]: ') || 'y';
    const backupEnabled = backupInput.toLowerCase() !== 'n';

    let remoteConfigDir = '/homeassistant';
    let localConfigDir = './';
    let sshConfig: SSHConfig | undefined = undefined;

    if (mode === 'local') {
      localConfigDir = await rl.question('Enter local Home Assistant configuration directory path [default: /config]: ') || '/config';
    } else {
      console.log('\n--- Configuring SSH/SFTP Connection ---');
      const autoProvStr = await rl.question('Do you want this wizard to automatically install and configure the SSH add-on on Home Assistant OS? (y/n) [default: y]: ') || 'y';
      const autoProvision = autoProvStr.toLowerCase() === 'y';

      if (autoProvision) {
        console.log('\nChecking if Home Assistant supports Supervisor add-ons...');
        let supportsSupervisor = false;
        try {
          await makeHaRequest(haUrl, haToken, 'GET', '/api/supervisor/info');
          supportsSupervisor = true;
          console.log('✅ Home Assistant OS / Supervised detected!');
        } catch {
          console.log('⚠️ Supervisor API check failed. Auto-provisioning is only supported on Home Assistant OS / Supervised.');
        }

        if (supportsSupervisor) {
          sshConfig = await runAutoSshProvisioning(rl, haUrl, haToken);
          if (sshConfig) {
            // Ask to auto-install HACS
            const installHacsStr = await rl.question('\nWould you like to install HACS (Home Assistant Community Store) automatically? (y/n) [default: y]: ') || 'y';
            if (installHacsStr.toLowerCase() === 'y') {
              await runHacsInstallation(sshConfig);
            }
          }
        }

        if (!sshConfig) {
          console.log('\nFalling back to manual SSH configuration...');
        }
      }

      // If not auto-provisioned (or failed/skipped), run manual
      if (!sshConfig) {
        sshConfig = await runManualSshSetup(rl);
      }

      remoteConfigDir = await rl.question('Enter remote configuration directory on HA host [default: /homeassistant]: ') || '/homeassistant';
    }

    // Prepare configuration file
    const newInstance: InstanceConfig = {
      url: haUrl,
      token: haToken.trim(),
      mode,
      backupEnabled,
      remoteConfigDir: mode === 'ssh' ? remoteConfigDir : undefined,
      localConfigDir: mode === 'local' ? localConfigDir : undefined,
      ssh: sshConfig
    };

    const configPath = path.join(os.homedir(), '.ha-synapse.json');
    let synapseConfig: HASynapseConfig = {
      defaultInstance: instanceName,
      instances: {}
    };

    if (fs.existsSync(configPath)) {
      try {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(fileContent) as HASynapseConfig;
        synapseConfig = {
          defaultInstance: parsed.defaultInstance || instanceName,
          instances: parsed.instances || {}
        };
      } catch {}
    }

    synapseConfig.instances[instanceName] = newInstance;
    fs.writeFileSync(configPath, JSON.stringify(synapseConfig, null, 2), 'utf8');
    
    console.log('\n======================================================');
    console.log('✅ Configuration saved successfully!');
    console.log(`Config File location: ${configPath}`);
    console.log('======================================================');

    // Print integration block
    const mcpScriptPath = path.resolve(__dirname, '../build/index.js').replace(/\\/g, '/');
    const isWindows = os.platform() === 'win32';
    const isMac = os.platform() === 'darwin';
    const claudeConfigPath = isWindows 
      ? '%APPDATA%\\Claude\\claude_desktop_config.json'
      : isMac 
        ? '~/Library/Application Support/Claude/claude_desktop_config.json'
        : '~/.config/Claude/claude_desktop_config.json';

    console.log('\n--- Claude Desktop Configuration Integration ---');
    console.log(`Copy the following configuration block into your Claude Desktop config file (typically at ${claudeConfigPath}):`);
    
    const claudeConfigSnippet = {
      mcpServers: {
        "ha-synapse": {
          command: "node",
          args: [mcpScriptPath]
        }
      }
    };
    
    console.log(JSON.stringify(claudeConfigSnippet, null, 2));
    console.log('======================================================');

  } catch (err: any) {
    console.error('\n❌ Setup Wizard failed:', err.message);
  } finally {
    rl.close();
  }
}

/**
 * Runs manual SSH path input.
 */
async function runManualSshSetup(rl: readline.Interface): Promise<SSHConfig> {
  const host = await rl.question('Enter SSH Host (IP/Domain): ');
  if (!host) throw new Error('SSH Host is required.');

  const portStr = await rl.question('Enter SSH Port [default: 22]: ') || '22';
  const port = parseInt(portStr, 10);

  const user = await rl.question('Enter SSH User [default: root]: ') || 'root';

  const isWindows = os.platform() === 'win32';
  const defaultKeyExample = isWindows ? 'C:\\Users\\<username>\\.ssh\\id_ed25519' : '~/.ssh/id_ed25519';
  const keyPath = await rl.question(`Enter local path to your SSH private key (e.g., ${defaultKeyExample}): `);
  if (!keyPath) throw new Error('SSH private key path is required.');

  const sshConfig: SSHConfig = {
    host,
    port,
    user,
    keyPath: path.resolve(keyPath.replace(/^~/, os.homedir()))
  };

  console.log('\nProbing SSH connection ciphers & validating credentials...');
  let connected = false;
  let workingPresetIndex = -1;

  for (let i = 0; i < ALGORITHM_PRESETS.length; i++) {
    const success = await probeSshConnection(sshConfig, ALGORITHM_PRESETS[i]);
    if (success) {
      connected = true;
      workingPresetIndex = i;
      break;
    }
  }

  if (connected && workingPresetIndex !== -1) {
    const selectedPreset = ALGORITHM_PRESETS[workingPresetIndex];
    if (selectedPreset) {
      sshConfig.algorithms = selectedPreset;
      console.log('✅ Connection verified! Applied custom SSH algorithm preset to configuration.');
    } else {
      console.log('✅ Connection verified!');
    }
  } else {
    console.log('\n⚠️ SSH credential verification failed.');
    const proceed = await rl.question('Do you want to save these connection options anyway? (y/n) [default: y]: ') || 'y';
    if (proceed.toLowerCase() !== 'y') {
      process.exit(1);
    }
  }

  return sshConfig;
}

/**
 * Installs and configures Terminal & SSH addon on HA OS.
 */
async function runAutoSshProvisioning(rl: readline.Interface, haUrl: string, token: string): Promise<SSHConfig | undefined> {
  try {
    // 1. Generate SSH Key Pair locally if needed
    const defaultKeyPath = path.join(os.homedir(), '.ssh', 'id_ed25519_ha_synapse');
    const defaultKeyExample = os.platform() === 'win32' 
      ? 'C:\\Users\\<username>\\.ssh\\id_ed25519_ha_synapse' 
      : '~/.ssh/id_ed25519_ha_synapse';

    if (!fs.existsSync(defaultKeyPath)) {
      console.log(`\nGenerating secure SSH key pair locally at: ${defaultKeyExample}...`);
      const sshDir = path.dirname(defaultKeyPath);
      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { recursive: true });
      }
      execSync(`ssh-keygen -t ed25519 -N "" -f "${defaultKeyPath}"`, { stdio: 'ignore' });
    }
    const publicKey = fs.readFileSync(`${defaultKeyPath}.pub`, 'utf8').trim();

    // 2. Extract host IP from HA URL
    const urlObj = new URL(haUrl);
    const host = urlObj.hostname;

    console.log(`Installing "Terminal & SSH" addon (core_ssh) on Home Assistant...`);
    await makeHaRequest(haUrl, token, 'POST', '/api/supervisor/addons/core_ssh/install');
    console.log('✅ Add-on installed successfully.');

    console.log('Configuring add-on options (setting authorized SSH key and exposing port 22)...');
    const optionsPayload = {
      options: {
        authorized_keys: [publicKey]
      },
      network: {
        "22/tcp": 22
      }
    };
    await makeHaRequest(haUrl, token, 'POST', '/api/supervisor/addons/core_ssh/options', optionsPayload);
    console.log('✅ Add-on options saved.');

    console.log('Starting SSH Server add-on...');
    await makeHaRequest(haUrl, token, 'POST', '/api/supervisor/addons/core_ssh/start');
    console.log('✅ Add-on started successfully.');

    // Wait for SSH to start listening (approx 3-5 seconds)
    console.log('Waiting for SSH server to wake up...');
    await new Promise(r => setTimeout(r, 4000));

    const sshConfig: SSHConfig = {
      host,
      port: 22,
      user: 'root',
      keyPath: defaultKeyPath
    };

    // Test connection to verify it works
    const checkConn = await probeSshConnection(sshConfig);
    if (checkConn) {
      console.log('✅ SSH provisioning completed and verified! Connected successfully.');
      return sshConfig;
    } else {
      console.log('⚠️ SSH started, but the connection test timed out. You may need to restart the add-on manually.');
      return sshConfig;
    }
  } catch (err: any) {
    console.error('❌ Auto-provisioning failed:', err.message);
    return undefined;
  }
}

/**
 * Installs HACS over SSH connection.
 */
async function runHacsInstallation(sshConfig: SSHConfig): Promise<void> {
  console.log('\nInstalling Home Assistant Community Store (HACS) over SSH...');
  const client = new Client();

  return new Promise<void>((resolve) => {
    client
      .on('ready', () => {
        console.log('Executing HACS official installation script...');
        client.exec('wget -O - https://get.hacs.xyz | bash -', (err, stream) => {
          if (err) {
            console.error('Failed to run HACS script:', err.message);
            client.end();
            resolve();
            return;
          }

          stream.on('data', (data: Buffer) => {
            process.stdout.write(data.toString());
          });

          stream.on('close', (code: number) => {
            client.end();
            if (code === 0) {
              console.log('\n✅ HACS installed successfully!');
              console.log('⚠️ IMPORTANT: You must restart Home Assistant core to activate HACS.');
            } else {
              console.log(`\nHACS script failed with exit code ${code}`);
            }
            resolve();
          });
        });
      })
      .on('error', (err) => {
        console.error('Failed to connect to SSH for HACS installation:', err.message);
        resolve();
      })
      .connect({
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.user,
        privateKey: fs.readFileSync(sshConfig.keyPath!),
      });
  });
}

/**
 * Utility function to send REST API requests to Home Assistant.
 */
async function makeHaRequest(haUrl: string, token: string, method: string, apiPath: string, body?: any): Promise<any> {
  const url = new URL(haUrl);
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: apiPath,
    method: method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ success: true });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', err => reject(err));
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Probes SSH credentials with specific algorithm options.
 */
async function probeSshConnection(sshConfig: SSHConfig, algorithms?: any): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new Client();
    client
      .on('ready', () => {
        client.end();
        resolve(true);
      })
      .on('error', () => {
        resolve(false);
      })
      .connect({
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.user,
        privateKey: fs.readFileSync(sshConfig.keyPath!),
        readyTimeout: 5000,
        algorithms: algorithms
      });
  });
}

runSetup();
