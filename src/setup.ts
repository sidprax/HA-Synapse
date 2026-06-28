import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Client } from 'ssh2';
import { HASynapseConfig, InstanceConfig, SSHConfig } from './types';

// Standard SSH algorithm presets for auto-probing
const ALGORITHM_PRESETS = [
  // Preset 1: Default node-ssh2 negotiation
  undefined,
  // Preset 2: Strict hmac-sha2-512-etm (matches your specific HA OS add-on config)
  {
    mac: ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com']
  },
  // Preset 3: Modern safe defaults
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
    const haUrl = await rl.question('2. Enter Home Assistant URL (e.g. http://10.0.2.52:8123): ');
    if (!haUrl) throw new Error('Home Assistant URL is required.');

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
      const host = await rl.question('Enter SSH Host (IP/Domain): ');
      if (!host) throw new Error('SSH Host is required in SSH mode.');

      const portStr = await rl.question('Enter SSH Port [default: 22]: ') || '22';
      const port = parseInt(portStr, 10);

      const user = await rl.question('Enter SSH User [default: root]: ') || 'root';
      const keyPath = await rl.question('Enter local path to your SSH private key (e.g., C:\\Users\\<username>\\.ssh\\id_ed25519): ');
      if (!keyPath) throw new Error('SSH private key path is required.');

      remoteConfigDir = await rl.question('Enter remote configuration directory on HA host [default: /homeassistant]: ') || '/homeassistant';

      sshConfig = {
        host,
        port,
        user,
        keyPath: path.resolve(keyPath.replace(/^~/, os.homedir()))
      };

      // Auto-Probing SSH connection algorithms
      console.log('\nProbing SSH algorithms & validating credentials...');
      let connected = false;
      let workingPresetIndex = -1;

      for (let i = 0; i < ALGORITHM_PRESETS.length; i++) {
        const preset = ALGORITHM_PRESETS[i];
        console.log(`  Probing connection profile ${i + 1}/${ALGORITHM_PRESETS.length}...`);
        
        const success = await probeSshConnection(sshConfig, preset);
        if (success) {
          console.log(`  ✅ Connection profile ${i + 1} succeeded!`);
          connected = true;
          workingPresetIndex = i;
          break;
        }
      }

      if (connected && workingPresetIndex !== -1) {
        const selectedPreset = ALGORITHM_PRESETS[workingPresetIndex];
        if (selectedPreset) {
          sshConfig.algorithms = selectedPreset;
          console.log('  Applied custom SSH algorithm preset to configuration.');
        }
      } else {
        console.log('\n⚠️ SSH credential validation failed. Please check your SSH host, user, and key path.');
        const proceed = await rl.question('Do you want to save the configuration anyway? (y/n) [default: y]: ') || 'y';
        if (proceed.toLowerCase() !== 'y') {
          process.exit(1);
        }
      }
    }

    // Prepare configuration file
    const newInstance: InstanceConfig = {
      url: haUrl.trim(),
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

    // Load existing config if it exists
    if (fs.existsSync(configPath)) {
      try {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(fileContent) as HASynapseConfig;
        synapseConfig = {
          defaultInstance: parsed.defaultInstance || instanceName,
          instances: parsed.instances || {}
        };
      } catch {
        // Ignore parsing errors and overwrite
      }
    }

    synapseConfig.instances[instanceName] = newInstance;

    // Write to user home folder
    fs.writeFileSync(configPath, JSON.stringify(synapseConfig, null, 2), 'utf8');
    
    console.log('\n======================================================');
    console.log('✅ Configuration saved successfully!');
    console.log(`Config File location: ${configPath}`);
    console.log('Note: Connection details are stored safely in your home directory and are excluded from version control.');
    console.log('======================================================');

    // Print integration block
    const mcpScriptPath = path.resolve(__dirname, '../build/index.js').replace(/\\/g, '/');
    console.log('\n--- Claude Desktop Configuration Integration ---');
    console.log('Copy the following configuration block into your "%APPDATA%\\Claude\\claude_desktop_config.json" file:');
    
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
