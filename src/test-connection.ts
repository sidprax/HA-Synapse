import path from 'path';
import { ConfigLoader } from './config-loader';
import { HAClient } from './ha-client';
import { SftpClientManager } from './sftp-client';
import { FileManager } from './file-manager';

// Force load from local configuration file
process.env.HA_MCP_CONFIG_PATH = path.resolve(__dirname, '../ha-synapse.json');

async function testConnection() {
  console.log('=== Starting HA Synapse Integration Test ===');
  console.log(`Config path: ${process.env.HA_MCP_CONFIG_PATH}`);

  // 1. Load config
  const loader = new ConfigLoader();
  const config = loader.getConfig();
  const defaultInstance = config.defaultInstance || 'home';
  console.log('Config loaded successfully.');
  console.log('Available instances:', Object.keys(config.instances));
  console.log('Default instance:', defaultInstance);

  const instConfig = loader.getInstance(defaultInstance);
  console.log(`Testing default instance "${defaultInstance}" with mode: ${instConfig.mode}`);

  // 2. HA API Client Connect
  console.log('\n--- 1. Testing REST & WebSocket APIs ---');
  const client = new HAClient(defaultInstance, instConfig);
  
  try {
    await client.connect();
    console.log('✅ WebSocket authenticated & state cache populated!');
    
    const states = client.getCachedStates();
    console.log(`Cache state count: ${states.length} entities`);
    
    // Print a few sample entities
    if (states.length > 0) {
      console.log('Sample entities (first 3):');
      states.slice(0, 3).forEach(s => {
        console.log(`  - ${s.entity_id}: state="${s.state}" friendly_name="${s.attributes.friendly_name || ''}"`);
      });
    }

    // Call config check
    console.log('\nTesting configuration check API...');
    const checkResult = await client.checkConfig();
    console.log('Config check response:', checkResult);

    // Call template rendering
    console.log('\nTesting Jinja2 template rendering API...');
    const tempText = "{{ 15 * 3 }} degrees is the limit. Sun state is {{ states('sun.sun') }}.";
    const rendered = await client.renderTemplate(tempText);
    console.log(`Template: "${tempText}"`);
    console.log(`Rendered: "${rendered.trim()}"`);

  } catch (err: any) {
    console.error('❌ REST / WebSocket API Test failed:', err.message);
  }

  // 3. File access and transaction validation rollback test
  console.log('\n--- 2. Testing File System & Transaction Rollback ---');
  const sftp = new SftpClientManager();
  const fileMgr = new FileManager(sftp);

  try {
    // Read configuration.yaml
    console.log('Reading configuration.yaml...');
    const configContent = await fileMgr.readFile(defaultInstance, instConfig, 'configuration.yaml', 'utf8') as string;
    console.log(`✅ Success! configuration.yaml content size: ${configContent.length} bytes.`);
    console.log('First 100 characters:\n', configContent.substring(0, 100).replace(/\n/g, '\\n'));

    // Write a temporary file
    const testPath = 'mcp_test_file.yaml';
    console.log(`\nWriting a valid test file "${testPath}"...`);
    const validContent = `
# Valid MCP Test Configuration file
input_boolean:
  mcp_test_toggle:
    name: MCP Test Toggle
    icon: mdi:robot
`;
    await fileMgr.writeFile(defaultInstance, instConfig, client, testPath, validContent);
    console.log('✅ Valid write and configuration check passed!');

    // Test writing an INVALID YAML file (should fail syntax/config checks and trigger rollback)
    console.log(`\nWriting an INVALID YAML file to "${testPath}" (checking validation rollback)...`);
    const invalidContent = `
# Invalid YAML Configuration
input_boolean:
  mcp_test_toggle:
    name: "MCP Test Toggle"
    broken_indentation:
     - item1
    - item2 # invalid indentation!
`;
    try {
      await fileMgr.writeFile(defaultInstance, instConfig, client, testPath, invalidContent);
      console.error('❌ Error: Expected write to fail, but it succeeded!');
    } catch (err: any) {
      console.log('✅ Success! Write correctly rejected. Error message received:');
      console.log(`  > ${err.message}`);
      
      // Verify that the file content was rolled back to the valid state
      console.log('Verifying file contents after rollback...');
      const currentContent = await fileMgr.readFile(defaultInstance, instConfig, testPath, 'utf8') as string;
      if (currentContent.trim() === validContent.trim()) {
        console.log('✅ Verification success: File rolled back to previous valid content!');
      } else {
        console.error('❌ Verification failed: File content does not match previous content!');
      }
    }

    // Cleanup: Delete the test file
    console.log(`\nCleaning up: Deleting "${testPath}"...`);
    const rootDir = instConfig.mode === 'local' ? (instConfig.localConfigDir || './') : (instConfig.remoteConfigDir || '/homeassistant');
    const absolutePath = path.posix.join(rootDir, testPath);
    await sftp.deleteFile(defaultInstance, instConfig, absolutePath);
    console.log('✅ Cleanup completed.');

  } catch (err: any) {
    console.error('❌ File System / Rollback Test failed:', err.message);
  } finally {
    sftp.disconnectAll();
    client.close();
  }

  console.log('\n=== Test Run Finished ===');
}

testConnection().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Test crashed with error:', err);
  process.exit(1);
});
