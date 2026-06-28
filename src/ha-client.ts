import WebSocket from 'ws';
import { InstanceConfig, HAEntityState, HAServiceDomain } from './types';

export class HAClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private restUrl: string;
  private token: string;
  private instanceName: string;

  private messageIdCounter = 1;
  private pendingReplies: Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }> = new Map();
  private statesCache: Map<string, HAEntityState> = new Map();
  private cacheReady = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(instanceName: string, config: InstanceConfig) {
    this.instanceName = instanceName;
    this.token = config.token;
    
    // Normalize URL
    const cleanUrl = config.url.replace(/\/$/, '');
    this.restUrl = cleanUrl;
    
    // Convert http(s) to ws(s)
    if (cleanUrl.startsWith('https://')) {
      this.wsUrl = cleanUrl.replace('https://', 'wss://') + '/api/websocket';
    } else {
      this.wsUrl = cleanUrl.replace('http://', 'ws://') + '/api/websocket';
    }
  }

  public getRestUrl(): string {
    return this.restUrl;
  }

  public getToken(): string {
    return this.token;
  }

  public async connect(): Promise<void> {
    if (this.destroyed) return;
    if (this.ws) return;

    return new Promise((resolve, reject) => {
      console.error(`[HAClient][${this.instanceName}] Connecting to WebSocket at ${this.wsUrl}`);
      const socket = new WebSocket(this.wsUrl);
      this.ws = socket;

      let authenticated = false;

      socket.on('open', () => {
        // Connection opened, wait for auth challenge
      });

      socket.on('message', async (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'auth_required') {
            socket.send(JSON.stringify({
              type: 'auth',
              access_token: this.token
            }));
            return;
          }

          if (msg.type === 'auth_invalid') {
            console.error(`[HAClient][${this.instanceName}] Authentication failed: ${msg.message}`);
            socket.close();
            reject(new Error(`Auth Invalid: ${msg.message}`));
            return;
          }

          if (msg.type === 'auth_ok') {
            authenticated = true;
            console.error(`[HAClient][${this.instanceName}] WebSocket Authenticated successfully.`);
            
            try {
              // 1. Initialize states cache
              await this.initializeStatesCache();
              // 2. Subscribe to state changes
              await this.subscribeToStateChanges();
              
              resolve();
            } catch (err: any) {
              reject(err);
            }
            return;
          }

          // Handle command replies
          if (msg.id && this.pendingReplies.has(msg.id)) {
            const callback = this.pendingReplies.get(msg.id)!;
            this.pendingReplies.delete(msg.id);
            if (msg.success) {
              callback.resolve(msg.result);
            } else {
              callback.reject(new Error(msg.error?.message || 'Unknown WebSocket command error'));
            }
            return;
          }

          // Handle incoming events (state changes)
          if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
            const stateData = msg.event.data;
            if (stateData && stateData.entity_id) {
              if (stateData.new_state) {
                this.statesCache.set(stateData.entity_id, stateData.new_state);
              } else {
                this.statesCache.delete(stateData.entity_id);
              }
            }
          }

        } catch (err: any) {
          console.error(`[HAClient][${this.instanceName}] Error processing WebSocket message:`, err.message);
        }
      });

      socket.on('close', (code, reason) => {
        console.error(`[HAClient][${this.instanceName}] WebSocket connection closed (${code}): ${reason.toString() || 'No reason'}`);
        this.cleanupConnection();
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });

      socket.on('error', (err) => {
        console.error(`[HAClient][${this.instanceName}] WebSocket error:`, err.message);
        if (!authenticated) {
          reject(err);
        }
      });
    });
  }

  public getCachedStates(): HAEntityState[] {
    return Array.from(this.statesCache.values());
  }

  public getCachedState(entityId: string): HAEntityState | undefined {
    return this.statesCache.get(entityId);
  }

  public isCacheReady(): boolean {
    return this.cacheReady;
  }

  public close(): void {
    this.destroyed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // --- WebSocket commands ---

  public async sendWSCommand<T = any>(type: string, extraArgs: Record<string, any> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket is not connected for instance "${this.instanceName}"`);
    }

    const id = this.messageIdCounter++;
    const payload = { id, type, ...extraArgs };

    return new Promise<T>((resolve, reject) => {
      this.pendingReplies.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pendingReplies.delete(id);
          reject(err);
        }
      });
    });
  }

  // --- REST API operations ---

  public async callService(domain: string, service: string, serviceData: Record<string, any> = {}): Promise<any> {
    const url = `${this.restUrl}/api/services/${domain}/${service}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(serviceData)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to call service ${domain}.${service}: HTTP ${response.status} - ${text}`);
    }
    return response.json();
  }

  public async renderTemplate(template: string): Promise<string> {
    const url = `${this.restUrl}/api/template`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ template })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to render template: HTTP ${response.status} - ${text}`);
    }
    return response.text();
  }

  public async checkConfig(): Promise<{ result: string; errors: string | null }> {
    const url = `${this.restUrl}/api/config/core/check_config`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to run configuration check: HTTP ${response.status} - ${text}`);
    }
    
    const result = await response.json();
    return {
      result: result.result,
      errors: result.errors
    };
  }

  public async getHistory(timestamp: string, endTime?: string, filterEntities?: string[]): Promise<any[]> {
    let url = `${this.restUrl}/api/history/period/${timestamp}`;
    const queryParams: string[] = [];
    
    if (endTime) {
      queryParams.push(`end_time=${encodeURIComponent(endTime)}`);
    }
    if (filterEntities && filterEntities.length > 0) {
      queryParams.push(`filter_entity_id=${encodeURIComponent(filterEntities.join(','))}`);
    }

    if (queryParams.length > 0) {
      url += `?${queryParams.join('&')}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to retrieve history: HTTP ${response.status} - ${text}`);
    }

    return response.json() as Promise<any[]>;
  }

  public async getServices(): Promise<HAServiceDomain[]> {
    const url = `${this.restUrl}/api/services`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch services: HTTP ${response.status} - ${text}`);
    }

    return response.json() as Promise<HAServiceDomain[]>;
  }

  public async fireEvent(eventType: string, eventData: Record<string, any> = {}): Promise<{ message: string }> {
    const url = `${this.restUrl}/api/events/${eventType}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventData)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fire event ${eventType}: HTTP ${response.status} - ${text}`);
    }

    return response.json();
  }

  // --- Private connection helpers ---

  private async initializeStatesCache(): Promise<void> {
    const states = await this.sendWSCommand<HAEntityState[]>('get_states');
    this.statesCache.clear();
    for (const state of states) {
      this.statesCache.set(state.entity_id, state);
    }
    this.cacheReady = true;
    console.error(`[HAClient][${this.instanceName}] Cached ${this.statesCache.size} entity states.`);
  }

  private async subscribeToStateChanges(): Promise<void> {
    await this.sendWSCommand('subscribe_events', { event_type: 'state_changed' });
    console.error(`[HAClient][${this.instanceName}] Subscribed to state_changed events.`);
  }

  private cleanupConnection(): void {
    this.ws = null;
    this.cacheReady = false;
    // Reject any pending replies
    for (const [id, callback] of this.pendingReplies.entries()) {
      callback.reject(new Error('Connection closed'));
      this.pendingReplies.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimeout) return;
    
    console.error(`[HAClient][${this.instanceName}] Scheduling reconnection in 5 seconds...`);
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.connect();
      } catch (err: any) {
        console.error(`[HAClient][${this.instanceName}] Reconnection attempt failed:`, err.message);
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      }
    }, 5000);
  }
}
