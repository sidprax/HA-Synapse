import { spawn } from 'child_process';
import path from 'path';

// Force load from local configuration file
const configPath = path.resolve(__dirname, '../ha-synapse.json');
const serverScript = path.resolve(__dirname, '../build/index.js');

async function runMcpClientTest() {
  console.log('=== Starting Pure MCP Client Protocol Test ===');
  console.log(`Spawning server process: node ${serverScript}`);
  
  const server = spawn('node', [serverScript], {
    env: {
      ...process.env,
      HA_MCP_CONFIG_PATH: configPath
    }
  });

  let stdoutBuffer = '';
  
  // Track replies by JSON-RPC ID
  const pendingRequests = new Map<number, (result: any) => void>();

  server.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    
    // Parse JSON-RPC messages separated by newlines
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.substring(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
      
      if (line) {
        try {
          const msg = JSON.parse(line);
          console.log(`\n[MCP Client] Received message from server:`);
          console.log(JSON.stringify(msg, null, 2));

          if (msg.id && pendingRequests.has(msg.id)) {
            const resolve = pendingRequests.get(msg.id)!;
            pendingRequests.delete(msg.id);
            resolve(msg);
          }
        } catch (err: any) {
          // If it's not JSON (e.g. console.error output routed incorrectly, though it should be on stderr), print it
          console.log(`[Server Non-JSON stdout]: ${line}`);
        }
      }
    }
  });

  server.stderr.on('data', (data) => {
    // Standard MCP servers output logs on stderr
    console.error(`[Server Log (stderr)]: ${data.toString().trim()}`);
  });

  server.on('close', (code) => {
    console.log(`\nServer process exited with code ${code}`);
  });

  // Helper to send a request and await reply
  function sendRequest(id: number, method: string, params: any = {}): Promise<any> {
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    
    console.log(`\n[MCP Client] Sending request: ${method} (id: ${id})`);
    
    return new Promise((resolve) => {
      pendingRequests.set(id, resolve);
      server.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  // Helper to send a notification (no reply expected)
  function sendNotification(method: string, params: any = {}) {
    const payload = {
      jsonrpc: '2.0',
      method,
      params
    };
    console.log(`\n[MCP Client] Sending notification: ${method}`);
    server.stdin.write(JSON.stringify(payload) + '\n');
  }

  try {
    // 1. Send initialize request
    const initReply = await sendRequest(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'mcp-test-client',
        version: '1.0.0'
      }
    });

    // 2. Send initialized notification
    sendNotification('notifications/initialized');

    // Wait a brief moment to let connections warm up
    await new Promise(r => setTimeout(r, 2000));

    // 3. Request tools list
    console.log('\n--- Requesting Available Tools ---');
    const toolsReply = await sendRequest(2, 'tools/list');
    const tools = toolsReply.result?.tools || [];
    console.log(`Server exposed ${tools.length} tools.`);

    // 4. Call tool: get_entity_list
    console.log('\n--- Calling Tool: get_entity_list ---');
    const listReply = await sendRequest(3, 'tools/call', {
      name: 'get_entity_list',
      arguments: {}
    });

    const contentText = listReply.result?.content?.[0]?.text;
    if (contentText) {
      const entities = JSON.parse(contentText);
      console.log(`\n✅ Successful MCP Call! Received list of ${entities.length} entities from server.`);
      
      // Filter for dog
      const dog = entities.filter((e: any) => e.entity_id.includes('dog') || e.friendly_name.toLowerCase().includes('dog'));
      console.log('Dog entities found via MCP tool call:', dog);
    } else {
      console.error('❌ Failed to get entity list content.');
    }

    // 5. Call tool: render_template
    console.log('\n--- Calling Tool: render_template ---');
    const tempReply = await sendRequest(4, 'tools/call', {
      name: 'render_template',
      arguments: {
        template: "The sun is {{ states('sun.sun') }}."
      }
    });
    console.log('Template render result:', tempReply.result?.content?.[0]?.text);

  } catch (err: any) {
    console.error('Test error:', err.message);
  } finally {
    console.log('\nTerminating server process...');
    server.kill('SIGINT');
  }
}

// Make sure it is compiled first, then run
runMcpClientTest();
