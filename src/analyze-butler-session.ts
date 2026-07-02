import fs from 'fs';
import readline from 'readline';

const transcriptPath = 'C:\\Users\\sidha\\.gemini\\antigravity\\brain\\85d85b54-b19d-4408-b982-2c681a29171a\\.system_generated\\logs\\transcript.jsonl';

async function analyzeSession() {
  console.log('=== Analyzing Transcript for "Enhancing AI butler Chat" ===');
  
  if (!fs.existsSync(transcriptPath)) {
    console.error(`Error: Transcript not found at ${transcriptPath}`);
    return;
  }

  const fileStream = fs.createReadStream(transcriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let totalSteps = 0;
  const toolCallsCount: Record<string, number> = {};
  const runCommands: string[] = [];
  const modifiedFiles: Set<string> = new Set();
  let directHaScriptInvocations = 0;

  for await (const line of rl) {
    totalSteps++;
    try {
      const step = JSON.parse(line);
      
      // Look for tool calls in PLANNER_RESPONSE or any model step
      if (step.tool_calls && Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          const name = tc.name || tc.MethodName;
          if (name) {
            toolCallsCount[name] = (toolCallsCount[name] || 0) + 1;
            
            // Check run_command arguments
            if (name === 'run_command' && tc.args?.CommandLine) {
              const cmd = tc.args.CommandLine;
              runCommands.push(cmd);
              if (cmd.includes('node') || cmd.includes('tsx') || cmd.includes('python')) {
                if (cmd.includes('ha-') || cmd.includes('conn') || cmd.includes('dog') || cmd.includes('test')) {
                  directHaScriptInvocations++;
                }
              }
            }

            // Check file modifications
            if ((name === 'replace_file_content' || name === 'write_to_file' || name === 'multi_replace_file_content') && tc.args?.TargetFile) {
              modifiedFiles.add(tc.args.TargetFile);
            }
          }
        }
      }
    } catch (e) {
      // Ignore parse errors on corrupted lines
    }
  }

  console.log(`\nProcessed ${totalSteps} total conversation steps.`);
  console.log('\n--- Tool Call Breakdown ---');
  for (const [tool, count] of Object.entries(toolCallsCount)) {
    console.log(`  ${tool}: ${count}`);
  }

  console.log('\n--- Files Modified ---');
  modifiedFiles.forEach(file => {
    console.log(`  ${file}`);
  });

  console.log('\n--- Shell Commands Run (Top 25) ---');
  const uniqueCommands = Array.from(new Set(runCommands));
  uniqueCommands.slice(0, 25).forEach(cmd => {
    console.log(`  ${cmd}`);
  });

  console.log(`\nUnique commands run: ${uniqueCommands.length}`);
  console.log(`Suspected direct HA connection scripts run: ${directHaScriptInvocations}`);
}

analyzeSession();
