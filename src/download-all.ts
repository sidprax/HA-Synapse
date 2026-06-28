import fs from 'fs';
import path from 'path';
import { Client } from 'ssh2';
import { ConfigLoader } from './config-loader';

// Force load from local configuration file
const configPath = path.resolve(__dirname, '../ha-synapse.json');
const artifactsDir = process.argv[2] 
  ? path.resolve(process.argv[2]) 
  : path.resolve(__dirname, '..');

const filesToDownload = [
  { remote: '/homeassistant/www/dog_snapshot.jpg', local: 'dog_snapshot.jpg' },
  { remote: '/homeassistant/www/hallway_snapshot.jpg', local: 'hallway_snapshot.jpg' },
  { remote: '/homeassistant/www/entryway_snapshot.jpg', local: 'entryway_snapshot.jpg' }
];

async function downloadAll() {
  console.log('=== Downloading All Snapshots Binary-Safely ===');
  
  process.env.HA_MCP_CONFIG_PATH = configPath;
  const loader = new ConfigLoader();
  const config = loader.getConfig();
  const instConfig = loader.getInstance('home');
  const sshConfig = instConfig.ssh!;

  const client = new Client();

  return new Promise<void>((resolve, reject) => {
    client
      .on('ready', async () => {
        console.log('SSH connection established. Requesting files...');
        
        try {
          for (const file of filesToDownload) {
            const destPath = path.join(artifactsDir, file.local);
            console.log(`Downloading ${file.remote} -> ${destPath}`);
            
            await new Promise<void>((res, rej) => {
              client.exec(`cat ${escapeShellArg(file.remote)}`, (err, stream) => {
                if (err) return rej(err);

                const chunks: Buffer[] = [];
                stream.on('data', (data: Buffer) => {
                  chunks.push(data);
                });

                stream.on('close', (code: number) => {
                  if (code === 0) {
                    const buffer = Buffer.concat(chunks);
                    fs.writeFileSync(destPath, buffer);
                    console.log(`  ✅ Downloaded ${buffer.length} bytes.`);
                    res();
                  } else {
                    rej(new Error(`Failed to cat ${file.remote}`));
                  }
                });
              });
            });
          }
          client.end();
          resolve();
        } catch (err) {
          client.end();
          reject(err);
        }
      })
      .on('error', (err) => {
        reject(err);
      })
      .connect({
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.user,
        privateKey: fs.readFileSync(sshConfig.keyPath!),
      });
  });
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

downloadAll().catch(err => {
  console.error('Download failed:', err);
  process.exit(1);
});
