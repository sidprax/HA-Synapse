import path from 'path';
import { ConfigLoader } from './config-loader';
import { HAClient } from './ha-client';

// Force load from local configuration file
process.env.HA_MCP_CONFIG_PATH = path.resolve(__dirname, '../ha-synapse.json');

async function findDogAdvanced() {
  console.log('=== Advanced Dog/Pet Tracking ===');
  
  const loader = new ConfigLoader();
  const config = loader.getConfig();
  const defaultInstance = config.defaultInstance || 'home';
  const instConfig = loader.getInstance(defaultInstance);

  const client = new HAClient(defaultInstance, instConfig);
  
  try {
    await client.connect();
    const states = client.getCachedStates();

    // 1. Search for any smart detection or animal/pet sensors
    console.log('\nSearching for Animal/Smart Detection sensors...');
    const petSensors = states.filter(s => {
      const id = s.entity_id.toLowerCase();
      const friendly = (s.attributes.friendly_name || '').toLowerCase();
      return id.includes('animal') || id.includes('pet') || friendly.includes('animal') || friendly.includes('pet') || id.includes('smart_detect') || friendly.includes('smart detect');
    });

    if (petSensors.length > 0) {
      console.log(`Found ${petSensors.length} smart detection/pet-related sensors:`);
      petSensors.forEach(s => {
        if (s.state !== 'unavailable' && s.state !== 'unknown') {
          console.log(`  - ${s.entity_id}: state="${s.state}" (${s.attributes.friendly_name || ''})`);
        }
      });
    }

    // 2. Look for active cameras and their attributes
    console.log('\nChecking active camera entities and their detection attributes...');
    const cameras = states.filter(s => s.entity_id.startsWith('camera.'));
    cameras.forEach(s => {
      if (s.state !== 'unavailable' && s.state !== 'unknown') {
        console.log(`  - Camera: ${s.entity_id} state="${s.state}" (${s.attributes.friendly_name || ''})`);
        // If there's an object detection count or attribute
        const detectAttrs = Object.keys(s.attributes).filter(k => k.includes('detect') || k.includes('object') || k.includes('animal') || k.includes('count'));
        if (detectAttrs.length > 0) {
          console.log('    Attributes:', JSON.stringify(
            detectAttrs.reduce((acc: any, k) => { acc[k] = s.attributes[k]; return acc; }, {}),
            null, 2
          ));
        }
      }
    });

    // 3. Search for recently triggered motion/occupancy sensors in rooms
    console.log('\nChecking recently triggered motion and occupancy sensors (currently "on")...');
    const activeSensors = states.filter(s => {
      const id = s.entity_id.toLowerCase();
      const isMotionOrOccupancy = id.includes('motion') || id.includes('occupancy') || id.includes('presence') || s.attributes.device_class === 'motion' || s.attributes.device_class === 'occupancy';
      return isMotionOrOccupancy && s.state === 'on';
    });

    if (activeSensors.length > 0) {
      console.log(`Found ${activeSensors.length} active motion/occupancy sensors:`);
      activeSensors.forEach(s => {
        console.log(`  - ${s.entity_id}: state="${s.state}" (${s.attributes.friendly_name || ''})`);
      });
    } else {
      console.log('No motion or occupancy sensors are currently "on".');
    }

  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    client.close();
    process.exit(0);
  }
}

findDogAdvanced().catch(err => {
  console.error(err);
  process.exit(1);
});
