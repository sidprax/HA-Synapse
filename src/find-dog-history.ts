import path from 'path';
import { ConfigLoader } from './config-loader';
import { HAClient } from './ha-client';

// Force load from local configuration file
process.env.HA_MCP_CONFIG_PATH = path.resolve(__dirname, '../ha-synapse.json');

async function findDogHistory() {
  console.log('=== Analyzing Dog Detection History (Last 24 Hours) ===');
  
  const loader = new ConfigLoader();
  const config = loader.getConfig();
  const defaultInstance = config.defaultInstance || 'home';
  const instConfig = loader.getInstance(defaultInstance);

  const client = new HAClient(defaultInstance, instConfig);
  
  try {
    await client.connect();
    
    // 24 hours ago in ISO format
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const animalEntities = [
      'binary_sensor.living_room_animal_detected',
      'binary_sensor.hallway_animal_detected',
      'binary_sensor.entryway_animal_detected',
      'binary_sensor.living_room_animal_detected_2',
      'binary_sensor.yawcam_ai_darksurfacecam_detector_triggered_dog'
    ];

    console.log(`Fetching history starting from: ${yesterday}`);
    const historyData = await client.getHistory(yesterday, undefined, animalEntities);
    
    console.log(`\nHistory results received for ${historyData.length} entities.`);
    
    const detections: Array<{ entity_id: string; friendly_name: string; timestamp: Date; state: string }> = [];

    historyData.forEach((statesList: any) => {
      if (Array.isArray(statesList)) {
        statesList.forEach((stateObj: any) => {
          // Look for detections (state "on")
          if (stateObj.state === 'on') {
            detections.push({
              entity_id: stateObj.entity_id,
              friendly_name: stateObj.attributes?.friendly_name || stateObj.entity_id,
              timestamp: new Date(stateObj.last_changed),
              state: stateObj.state
            });
          }
        });
      }
    });

    // Sort detections by timestamp (newest first)
    detections.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (detections.length > 0) {
      console.log(`\nFound ${detections.length} total dog/animal detection events in the last 24 hours:`);
      
      // Print the top 10 most recent detection events
      detections.slice(0, 10).forEach((det, index) => {
        // Convert to local time format
        const localTimeStr = det.timestamp.toLocaleString('en-US', { timeZone: 'America/New_York' });
        console.log(`  ${index + 1}. [${localTimeStr}] ${det.friendly_name} (${det.entity_id}) detected an animal!`);
      });

      // Highlight the absolute most recent location
      const mostRecent = detections[0];
      const timeAgoMins = Math.round((Date.now() - mostRecent.timestamp.getTime()) / (60 * 1000));
      const localTimeStr = mostRecent.timestamp.toLocaleString('en-US', { timeZone: 'America/New_York' });
      
      console.log('\n======================================================');
      console.log(`🚨 SUMMARY: Your dog was last detected in the:`);
      console.log(`👉 "${mostRecent.friendly_name}" area`);
      console.log(`👉 Time: ${localTimeStr} (${timeAgoMins} minutes ago)`);
      console.log('======================================================');

    } else {
      console.log('\nNo dog or animal detections were recorded in the last 24 hours.');
      
      // Let's check the last_changed attribute on the current live state objects to see when they last flipped
      console.log('\nChecking last_changed timestamps on live entities...');
      animalEntities.forEach(id => {
        const liveState = client.getCachedState(id);
        if (liveState) {
          console.log(`  - ${id}: state="${liveState.state}" last_changed="${new Date(liveState.last_changed).toLocaleString()}"`);
        }
      });
    }

  } catch (err: any) {
    console.error('Error analyzing history:', err.message);
  } finally {
    client.close();
    process.exit(0);
  }
}

findDogHistory().catch(err => {
  console.error(err);
  process.exit(1);
});
