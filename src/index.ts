import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'path';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ConfigLoader } from './config-loader';
import { HAClient } from './ha-client';
import { SftpClientManager } from './sftp-client';
import { FileManager } from './file-manager';

// Load configuration
const configLoader = new ConfigLoader();
const sysConfig = configLoader.getConfig();

const sftpManager = new SftpClientManager();
const fileManager = new FileManager(sftpManager);
const clients: Map<string, HAClient> = new Map();

// Initialize Home Assistant clients
async function initHAConnection() {
  for (const [name, instConfig] of Object.entries(sysConfig.instances)) {
    try {
      const client = new HAClient(name, instConfig);
      // Try to connect asynchronously; don't block entire startup if one is down
      client.connect().catch((err) => {
        console.error(`[Synapse] Failed to connect to instance "${name}":`, err.message);
      });
      clients.set(name, client);
    } catch (err: any) {
      console.error(`[Synapse] Error initializing client for "${name}":`, err.message);
    }
  }
}

// Get client by requested instance name or default
function getClientAndConfig(requestedInstance?: string): { name: string; client: HAClient; config: any } {
  const name = requestedInstance || sysConfig.defaultInstance || 'default';
  const client = clients.get(name);
  const config = sysConfig.instances[name];
  
  if (!client || !config) {
    throw new Error(
      `Instance "${name}" is not configured. Configured instances: ${Object.keys(sysConfig.instances).join(', ')}`
    );
  }
  return { name, client, config };
}

// Start Server
const server = new Server(
  {
    name: 'ha-synapse',
    version: '1.0.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// --- Define Tools ---
const TOOLS: Tool[] = [
  {
    name: 'get_entity_list',
    description: 'Retrieves a summarized list of all Home Assistant entities (includes entity_id, state, and friendly_name). Use this to quickly discover available entities.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance to query. Defaults to the default instance.',
        },
      },
    },
  },
  {
    name: 'get_entity_details',
    description: 'Retrieves full details (attributes, context, states) for specific entity IDs. Call this when you need detailed properties of specific sensors/devices.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of entity IDs to fetch details for (e.g., ["light.living_room", "climate.bedroom"]).',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance to query.',
        },
      },
      required: ['entity_ids'],
    },
  },
  {
    name: 'search_entities',
    description: 'Filters and searches entities by area, domain, or string query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring search for entity ID or friendly name.',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain name (e.g. "light", "climate", "switch", "sensor").',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance to query.',
        },
      },
    },
  },
  {
    name: 'get_services',
    description: 'Returns all available Home Assistant service domains, operations, and parameter schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance to query.',
        },
      },
    },
  },
  {
    name: 'call_service',
    description: 'Triggers a service call in Home Assistant (e.g., toggling a light, announcing a TTS message on a speaker, setting temperature).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The service domain (e.g. "light", "media_player", "homeassistant").',
        },
        service: {
          type: 'string',
          description: 'The service name (e.g. "turn_on", "volume_set", "reload_core_config").',
        },
        serviceData: {
          type: 'object',
          description: 'JSON object payload with service arguments (e.g. {"entity_id": "light.living_room", "brightness": 255}).',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['domain', 'service'],
    },
  },
  {
    name: 'read_ha_file',
    description: 'Reads a configuration file (like configuration.yaml or a dashboard YAML file) from the sandboxed configuration directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The relative path of the file to read (e.g. "configuration.yaml", "dashboard/premium_dashboard.yaml").',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_ha_file',
    description: 'Writes/modifies a configuration file in the sandboxed configuration directory. For YAML files, this automatically lints the syntax, takes a backup, validates configuration against HA core, and rolls back if check_config fails.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The relative path of the file to write (e.g. "packages/climate_automations.yaml").',
        },
        content: {
          type: 'string',
          description: 'Full file content text.',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'render_template',
    description: 'Renders a Jinja2 template string using Home Assistant template rendering engine. Excellent for testing state query calculations or formatting speech output.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          description: 'The template string to render (e.g. "The current outside temperature is {{ states(\'sensor.outdoor_temp\') }}°C").',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['template'],
    },
  },
  {
    name: 'get_history',
    description: 'Fetches historical state changes for specific entity IDs starting from a timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        timestamp: {
          type: 'string',
          description: 'The start date/time in ISO 8601 format (e.g. "2026-06-28T00:00:00Z").',
        },
        endTime: {
          type: 'string',
          description: 'Optional end date/time in ISO 8601 format.',
        },
        filter_entity_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of entity IDs to filter history results.',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['timestamp'],
    },
  },
  {
    name: 'get_automation_traces',
    description: 'Retrieves a list of recent execution traces for a specific automation ID.',
    inputSchema: {
      type: 'object',
      properties: {
        automation_id: {
          type: 'string',
          description: 'The unique ID of the automation (found in its YAML config id attribute, e.g. "1719643455").',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['automation_id'],
    },
  },
  {
    name: 'get_automation_trace_details',
    description: 'Fetches detailed execution step data for a specific automation run ID.',
    inputSchema: {
      type: 'object',
      properties: {
        automation_id: {
          type: 'string',
          description: 'The unique ID of the automation.',
        },
        run_id: {
          type: 'string',
          description: 'The run ID from get_automation_traces.',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['automation_id', 'run_id'],
    },
  },
  {
    name: 'validate_ha_config',
    description: 'Triggers the Home Assistant configuration check endpoint to verify configuration validity.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
    },
  },
  {
    name: 'reload_ha',
    description: 'Reloads core configuration, templates, scripts, helpers, and automations without restarting Home Assistant core.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
    },
  },
  {
    name: 'restart_ha',
    description: 'Restarts the Home Assistant core instance. Use with caution.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
    },
  },
  {
    name: 'get_ha_logs',
    description: 'Retrieve the latest Home Assistant core logs from home-assistant.log.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'integer',
          description: 'Number of log lines to retrieve (default: 50, max: 500).',
        },
        filter: {
          type: 'string',
          description: 'Case-insensitive keyword to filter log lines (e.g. "ERROR" or "warning").',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
    },
  },
  {
    name: 'manage_lovelace_resources',
    description: 'List, create, update, or delete Lovelace dashboard resources (custom cards, themes, modules). Bumping url query params (e.g. ?v=1.0.1) forces browsers to refresh their caches.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete'],
          description: 'Action to perform: list, create, update, delete.',
        },
        resourceId: {
          type: 'string',
          description: 'The unique ID of the Lovelace resource (required for update and delete actions).',
        },
        resourceType: {
          type: 'string',
          enum: ['css', 'js', 'module', 'html'],
          description: 'Type of resource (required for create and update actions, default is module).',
        },
        url: {
          type: 'string',
          description: 'The URL path of the resource (e.g., "/local/custom-card.js?v=1.0.0", required for create and update actions).',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'execute_host_command',
    description: 'Executes an arbitrary shell command on the Home Assistant host (SSH mode only). Use this to check host processes, disk usage, or run network diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run on the HA host.',
        },
        instance: {
          type: 'string',
          description: 'The name of the Home Assistant instance.',
        },
      },
      required: ['command'],
    },
  },
];

// --- Register Handlers ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const instanceArg = args?.instance as string | undefined;

  try {
    const { name: instName, client, config } = getClientAndConfig(instanceArg);

    switch (name) {
      case 'get_entity_list': {
        const states = client.getCachedStates();
        const list = states.map((s) => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: s.attributes.friendly_name || '',
        }));
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
      }

      case 'get_entity_details': {
        const entityIds = args?.entity_ids as string[];
        const details = entityIds.map((id) => {
          const state = client.getCachedState(id);
          return state || { entity_id: id, state: 'unknown', error: 'Not found in cache' };
        });
        return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
      }

      case 'search_entities': {
        const query = (args?.query as string || '').toLowerCase();
        const domain = args?.domain as string | undefined;
        let states = client.getCachedStates();

        if (domain) {
          states = states.filter((s) => s.entity_id.startsWith(`${domain}.`));
        }
        if (query) {
          states = states.filter(
            (s) =>
              s.entity_id.toLowerCase().includes(query) ||
              (s.attributes.friendly_name || '').toLowerCase().includes(query)
          );
        }
        return { content: [{ type: 'text', text: JSON.stringify(states, null, 2) }] };
      }

      case 'get_services': {
        const services = await client.getServices();
        return { content: [{ type: 'text', text: JSON.stringify(services, null, 2) }] };
      }

      case 'call_service': {
        const domain = args?.domain as string;
        const service = args?.service as string;
        const serviceData = (args?.serviceData as Record<string, any>) || {};
        const result = await client.callService(domain, service, serviceData);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, result }, null, 2) }] };
      }

      case 'read_ha_file': {
        const filePath = args?.path as string;
        const ext = path.extname(filePath).toLowerCase().substring(1);
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

        if (imageExtensions.includes(ext)) {
          const fileBuffer = await fileManager.readFile(instName, config, filePath, null) as Buffer;
          const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          return {
            content: [
              {
                type: 'image',
                data: fileBuffer.toString('base64'),
                mimeType
              }
            ]
          };
        } else {
          const fileContent = await fileManager.readFile(instName, config, filePath, 'utf8') as string;
          return { content: [{ type: 'text', text: fileContent }] };
        }
      }

      case 'write_ha_file': {
        const filePath = args?.path as string;
        const content = args?.content as string;
        await fileManager.writeFile(instName, config, client, filePath, content);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `File ${filePath} written successfully.` }) }] };
      }

      case 'render_template': {
        const template = args?.template as string;
        const rendered = await client.renderTemplate(template);
        return { content: [{ type: 'text', text: rendered }] };
      }

      case 'get_history': {
        const timestamp = args?.timestamp as string;
        const endTime = args?.endTime as string | undefined;
        const filterIds = args?.filter_entity_ids as string[] | undefined;
        const history = await client.getHistory(timestamp, endTime, filterIds);
        return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] };
      }

      case 'get_automation_traces': {
        const automationId = args?.automation_id as string;
        const traces = await client.sendWSCommand('trace/list', {
          domain: 'automation',
          item_id: automationId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(traces, null, 2) }] };
      }

      case 'get_automation_trace_details': {
        const automationId = args?.automation_id as string;
        const runId = args?.run_id as string;
        const trace = await client.sendWSCommand('trace/get', {
          domain: 'automation',
          item_id: automationId,
          run_id: runId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(trace, null, 2) }] };
      }

      case 'validate_ha_config': {
        const check = await client.checkConfig();
        return { content: [{ type: 'text', text: JSON.stringify(check, null, 2) }] };
      }

      case 'reload_ha': {
        // Run standard reload services sequentially
        await client.callService('homeassistant', 'reload_core_config');
        await new Promise((r) => setTimeout(r, 1000));
        await client.callService('automation', 'reload');
        await client.callService('script', 'reload');
        await client.callService('template', 'reload');
        await client.callService('frontend', 'reload_themes');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Reload commands triggered.' }) }] };
      }

      case 'restart_ha': {
        await client.callService('homeassistant', 'restart');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Restart command sent.' }) }] };
      }

      case 'get_ha_logs': {
        const lines = (args?.lines as number) || 50;
        const filterStr = args?.filter as string | undefined;

        const logPath = 'home-assistant.log';
        const exists = await fileManager.exists(instName, config, logPath);
        if (!exists) {
          return { content: [{ type: 'text', text: 'Log file home-assistant.log not found.' }] };
        }

        const content = await fileManager.readFile(instName, config, logPath, 'utf8') as string;
        let logLines = content.split('\n');

        if (filterStr) {
          const lowerFilter = filterStr.toLowerCase();
          logLines = logLines.filter((line) => line.toLowerCase().includes(lowerFilter));
        }

        const tailLines = logLines.slice(-lines);
        return { content: [{ type: 'text', text: tailLines.join('\n') }] };
      }

      case 'manage_lovelace_resources': {
        const action = args?.action as string;
        const resourceId = args?.resourceId as string | number | undefined;
        const resourceType = (args?.resourceType as string) || 'module';
        const url = args?.url as string | undefined;

        switch (action) {
          case 'list': {
            const list = await client.sendWSCommand('lovelace/resources');
            return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
          }
          case 'create': {
            if (!url) throw new Error('url parameter is required for create action.');
            const res = await client.sendWSCommand('lovelace/resources/create', {
              res_type: resourceType,
              url,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, result: res }, null, 2) }] };
          }
          case 'update': {
            if (!resourceId) throw new Error('resourceId parameter is required for update action.');
            const updateArgs: Record<string, any> = { resource_id: resourceId };
            if (url) updateArgs.url = url;
            if (resourceType) updateArgs.res_type = resourceType;

            const res = await client.sendWSCommand('lovelace/resources/update', updateArgs);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, result: res }, null, 2) }] };
          }
          case 'delete': {
            if (!resourceId) throw new Error('resourceId parameter is required for delete action.');
            const res = await client.sendWSCommand('lovelace/resources/delete', {
              resource_id: resourceId,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, result: res }, null, 2) }] };
          }
          default:
            throw new Error(`Invalid action: ${action}`);
        }
      }

      case 'execute_host_command': {
        if (config.mode !== 'ssh') {
          return { content: [{ type: 'text', text: 'Host commands can only be executed in SSH mode.' }] };
        }
        const command = args?.command as string;
        const result = await sftpManager.executeSshCommand(instName, config.ssh!, command);
        return { content: [{ type: 'text', text: result }] };
      }

      default:
        throw new Error(`Tool "${name}" not found.`);
    }
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: err.message || 'Unknown execution error' }],
    };
  }
});

// --- Resources ---

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = [];
  for (const name of Object.keys(sysConfig.instances)) {
    resources.push(
      {
        uri: `ha://${name}/states`,
        name: `States snapshot for HA instance: ${name}`,
        mimeType: 'application/json',
      },
      {
        uri: `ha://${name}/services`,
        name: `Registered services for HA instance: ${name}`,
        mimeType: 'application/json',
      },
      {
        uri: `ha://${name}/config`,
        name: `Core configuration of HA instance: ${name}`,
        mimeType: 'application/json',
      }
    );
  }
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  
  // Parse uri: ha://{instance}/[states|services|config]
  const match = uri.match(/^ha:\/\/([^\/]+)\/(states|services|config)$/);
  if (!match) {
    throw new Error(`Invalid resource URI: ${uri}`);
  }

  const [, instanceName, resourceType] = match;
  const { client } = getClientAndConfig(instanceName);

  switch (resourceType) {
    case 'states': {
      const states = client.getCachedStates();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(states, null, 2),
          },
        ],
      };
    }
    case 'services': {
      const services = await client.getServices();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(services, null, 2),
          },
        ],
      };
    }
    case 'config': {
      const response = await fetch(`${client.getRestUrl()}/api/config`, {
        headers: {
          'Authorization': `Bearer ${client.getToken()}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await response.json();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
    default:
      throw new Error(`Resource type "${resourceType}" not supported.`);
  }
});

// --- Lifecycle Cleanup ---
process.on('SIGINT', () => {
  console.error('[Synapse] Received SIGINT. Cleaning up connections...');
  sftpManager.disconnectAll();
  for (const client of clients.values()) {
    client.close();
  }
  process.exit(0);
});

// Run server
async function main() {
  await initHAConnection();
  console.error('[Synapse] Initializing stdio transport...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Synapse] HA Synapse MCP server started successfully.');
}

main().catch((err) => {
  console.error('[Synapse] Critical error in server:', err);
  process.exit(1);
});
