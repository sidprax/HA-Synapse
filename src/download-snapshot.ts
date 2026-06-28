import fs from 'fs';
import path from 'path';
import { Client } from 'ssh2';
import { ConfigLoader } from './config-loader';

// Force load from local configuration file
const configPath = path.resolve(__dirname, '../ha-synapse.json');
const destPath = process.argv[2] 
  ? path.resolve(process.argv[2]) 
  : path.resolve(__dirname, '../dog_snapshot.jpg');

async function downloadSnapshot() {
  console.log('=== Downloading Camera Snapshot Binary-Safely ===');
  
  process.env.HA_MCP_CONFIG_PATH = configPath;
  const loader = new ConfigLoader();
  const config = loader.getConfig();
  const instConfig = loader.getInstance('home');
  const sshConfig = instConfig.ssh!;

  const client = new Client();

  return new Promise<void>((resolve, reject) => {
    client
      .on('ready', () => {
        console.log('SSH connection established. Requesting file...');
        client.exec('cat /homeassistant/www/dog_snapshot.jpg', (err, stream) => {
          if (err) {
            client.end();
            return reject(err);
          }

          const chunks: Buffer[] = [];
          stream.on('data', (data: Buffer) => {
            chunks.push(data);
          });

          stream.on('close', (code: number) => {
            client.end();
            if (code === 0) {
              const buffer = Buffer.concat(chunks);
              fs.writeFileSync(destPath, buffer);
              console.log(`✅ Success! Snapshot saved locally to: ${destPath} (${buffer.length} bytes)`);
              resolve();
            } else {
              reject(new Error(`SSH cat command failed with exit code ${code}`));
            }
          });
        });
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

downloadSnapshot().catch(err => {
  console.error('Download failed:', err);
  process.exit(1);
});
