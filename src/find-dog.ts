import path from 'path';
import { ConfigLoader } from './config-loader';
import { HAClient } from './ha-client';

// Force load from local configuration file
process.env.HA_MCP_CONFIG_PATH = path.resolve(__dirname, '../ha-synapse.json');

async function findDog() {
  console.log('=== Locating Dog in Home Assistant ===');
  
  const loader = new ConfigLoader();
  const config = loader.getConfig();
  const defaultInstance = config.defaultInstance || 'home';
  const instConfig = loader.getInstance(defaultInstance);

  const client = new HAClient(defaultInstance, instConfig);
  
  try {
    await client.connect();
    const states = client.getCachedStates();
    
    // Search terms
    const searchTerms = ['dog', 'pet', 'collar', 'tracker', 'camera', 'occupancy', 'presence'];
    
    console.log(`\nSearching through ${states.length} active entities...`);
    
    const dogEntities = states.filter(s => {
      const entityId = s.entity_id.toLowerCase();
      const friendlyName = (s.attributes.friendly_name || '').toLowerCase();
      return entityId.includes('dog') || friendlyName.includes('dog');
    });

    if (dogEntities.length > 0) {
      console.log(`\nFound ${dogEntities.length} entities directly related to "dog":`);
      dogEntities.forEach(s => {
        console.log(`\n[Entity] ${s.entity_id}`);
        console.log(`  State: ${s.state}`);
        console.log(`  Friendly Name: ${s.attributes.friendly_name || 'N/A'}`);
        if (s.attributes.latitude && s.attributes.longitude) {
          console.log(`  GPS Coordinate: ${s.attributes.latitude}, ${s.attributes.longitude}`);
        }
        // Print relevant attributes
        const filteredAttributes = { ...s.attributes };
        delete filteredAttributes.friendly_name;
        delete filteredAttributes.templates;
        console.log('  Attributes:', JSON.stringify(filteredAttributes, null, 2));
      });
    } else {
      console.log('\nNo entities directly containing "dog" in their name were found.');
    }

    // Also search for general cameras, trackable device trackers, and room occupancies to see if we can deduce location
    console.log('\n--- General Location & Camera Status ---');
    const locationEntities = states.filter(s => {
      const entityId = s.entity_id.toLowerCase();
      const friendlyName = (s.attributes.friendly_name || '').toLowerCase();
      // Look for device trackers or bluetooth trackers
      return entityId.startsWith('device_tracker.') || entityId.startsWith('camera.') || entityId.startsWith('zone.');
    });

    console.log(`Found ${locationEntities.length} general tracking/camera entities.`);
    // Print active device trackers or cameras that might be tracking the dog
    const activeTrackers = locationEntities.filter(s => s.entity_id.startsWith('device_tracker.') && s.state !== 'not_home');
    if (activeTrackers.length > 0) {
      console.log('\nActive Device Trackers:');
      activeTrackers.forEach(s => {
        console.log(`  - ${s.entity_id}: state="${s.state}" (${s.attributes.friendly_name || ''})`);
      });
    }

    // Let's render a quick template to see if there are any specific dog trackers (e.g. Tile, AirTag, Bluetooth, companion apps)
    // that might be custom defined or grouped.
    console.log('\nChecking for any custom templates or groups...');
    const result = await client.renderTemplate(`
      {%- set dog = states.device_tracker | selectattr('entity_id', 'search', 'dog') | list -%}
      {%- if dog | length > 0 -%}
        Dog Trackers: {{ dog | map(attribute='entity_id') | join(', ') }}
      {%- else -%}
        No device_trackers match 'dog'.
      {%- endif -%}
    `);
    console.log(result.trim());

  } catch (err: any) {
    console.error('Error locating dog:', err.message);
  } finally {
    client.close();
    process.exit(0);
  }
}

findDog().catch(err => {
  console.error('Find dog script crashed:', err);
  process.exit(1);
});
