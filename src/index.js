import { DurableObject } from "cloudflare:workers";
import { removeStopwords, eng } from 'stopword';
import filter from 'leo-profanity';

// --- 1. The Gateway Worker ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = env.WIKI_STATS.idFromName('global-stats');
    const stub = env.WIKI_STATS.get(id);

    // RPC CALLS: No more manual fetch() inside the worker!
    if (url.pathname === '/api/history') {
      const history = await stub.getHistory();
      return Response.json(history);
    }

    if (url.pathname === '/api/restart') {
      await stub.startStream();
      return new Response("Restarting");
    }

    // SSE Stream still uses fetch because it's a persistent HTTP connection
    return stub.fetch(request);
  }
};

// --- 2. The Durable Object (Modern SDK) ---
export class WikiStats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.history = []; 
    this.clients = new Set();
    this.buffer = this.resetBuffer();
    filter.loadDictionary('en');

    this.initialize();
  }

  async initialize() {
    this.lastEventDt = await this.ctx.storage.get("lastEventDt");
    this.startStream();
    this.ctx.storage.setAlarm(Date.now() + 10000);
  }

  // RPC METHOD: Exposed directly to the Worker
  async getHistory() {
    return this.history;
  }

  resetBuffer() {
    return { major: 0, minor: 0, delta: 0, words: new Map() };
  }

  async startStream() {
    if (this.esInstance && this.esInstance.body) {
      try {
        this.esInstance.body.cancel();
      } catch (e) {
        // Ignore cancellation errors
      }
    }
    this.esInstance = null;
    const since = this.lastEventDt || new Date(Date.now() - 3600000).toISOString();
    
    try {
      const uaString = `${this.env.CF_WORKER_NAME || this.env.PROJECT_NAME || 'wikihour-base'}/1.0; ${this.env.CF_WORKER_SCRIPT_NAME || 'https://github.com/jamesplease/wikihour-base'}; ${this.env.CF_WORKER_ENV || 'Development'}`;
      
      // Use fetch instead of EventSource to set custom headers
      this.esInstance = await fetch(`https://stream.wikimedia.org/v2/stream/recentchange`, {
        headers: {
          'User-Agent': uaString,
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      });
      
      if (!this.esInstance.ok) {
        throw new Error(`HTTP ${this.esInstance.status}: ${this.esInstance.statusText}`);
      }
      
      const reader = this.esInstance.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      this.processStream(reader, decoder, buffer);
    } catch (e) { 
      console.error('Stream connection error:', e);
      this.lastHeartbeat = 0; 
    }
  }

  async processStream(reader, decoder, buffer) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const eventData = line.slice(6);
              if (eventData.trim()) {
                const d = JSON.parse(eventData);
                if (d.meta?.dt) {
                  this.lastEventDt = d.meta.dt;
                  this.lastHeartbeat = Date.now();
                }
                if (d.bot === true) continue; 
                if (d.meta?.domain === 'canary') continue; 
                if (d.server_name !== 'en.wikipedia.org') continue;

                this.parseEvent(d);
              }
            } catch (e) {
              console.warn('Error parsing event:', e);
            }
          }
        }
      }
    } catch (e) {
      console.error('Stream processing error:', e);
      this.lastHeartbeat = 0;
    }
  }

  parseEvent(d) {
    if (d.minor) this.buffer.minor++;
    else this.buffer.major++;
    if (d.length) this.buffer.delta += (d.length.new - d.length.old);
    const words = d.title.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    for (const w of words) this.buffer.words.set(w, (this.buffer.words.get(w) || 0) + 1);
  }

  async alarm() {
    if (Date.now() - this.lastHeartbeat > 60000) await this.startStream();
    if (this.lastEventDt) await this.ctx.storage.put("lastEventDt", this.lastEventDt);
    
    await this.flush();
    this.ctx.storage.setAlarm(Date.now() + 10000);
  }

  async flush() {
    const rawKeys = Array.from(this.buffer.words.keys());
    const wikiNoise = ['wikipedia', 'user', 'talk', 'page', 'edit', 'article'];
    const filtered = removeStopwords(rawKeys, [...eng, ...wikiNoise]);
    
    let localCensored = 0;
    let finalMap = new Map();

    for (const w of filtered) {
      const count = this.buffer.words.get(w);
      if (filter.check(w)) {
        localCensored++;
        finalMap.set('****', (finalMap.get('****') || 0) + count);
      } else {
        finalMap.set(w, count);
      }
    }

    const chunk = {
      time: new Date().toISOString(),
      edits: { ...this.buffer },
      delta: this.buffer.delta,
      words: Array.from(finalMap.entries()).map(([word, count]) => ({word, count})).sort((a,b) => b.count - a.count).slice(0,20),
      censorship: { safetyScore: filtered.length > 0 ? 100 - ((localCensored / filtered.length) * 100) : 100 }
    };

    this.history.push(chunk);
    if (this.history.length > 360) this.history.shift();
    
    const msg = `data: ${JSON.stringify(chunk)}\n\n`;
    for (const c of this.clients) {
      try { c.enqueue(new TextEncoder().encode(msg)); } catch (e) { this.clients.delete(c); }
    }
    this.buffer = this.resetBuffer();
  }

  // fetch() is now ONLY used for the SSE stream connection
  async fetch(request) {
    const stream = new ReadableStream({
      start: (controller) => {
        this.clients.add(controller);
        request.signal.addEventListener('abort', () => this.clients.delete(controller));
      }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }
}
