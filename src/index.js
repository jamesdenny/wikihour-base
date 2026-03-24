import { removeStopwords, eng } from 'stopword';
import filter from 'leo-profanity';

export default {
  async fetch(request, env) {
    const id = env.WIKI_STATS.idFromName('global-stats');
    const obj = env.WIKI_STATS.get(id);
    return obj.fetch(request);
  }
};

export class WikiStats {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.history = []; // Rolling 1-hour history (360 chunks)
    this.buffer = this.resetBuffer();
    this.clients = new Set();
    
    // Resilience State
    this.lastEventDt = null; 
    this.lastHeartbeat = Date.now();
    this.esInstance = null;

    filter.loadDictionary('en');
    
    // Start the engine
    this.initialize();
  }

  async initialize() {
    // Recover last known event time from persistent storage
    this.lastEventDt = await this.state.storage.get("lastEventDt");
    this.startStream();
    this.state.storage.setAlarm(Date.now() + 10000);
  }

  resetBuffer() {
    return { major: 0, minor: 0, bot: 0, delta: 0, words: new Map() };
  }

  async startStream() {
    if (this.esInstance) this.esInstance.close();

    // The "Time Machine": Backfill holes using 'since'
    const since = this.lastEventDt || new Date(Date.now() - 3600000).toISOString();
    console.log(`📡 Connecting to Wikipedia since: ${since}`);

    try {
      this.esInstance = new EventSource(`https://stream.wikimedia.org{since}`);

      this.esInstance.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data);
          
          // Update Heartbeat & High Water Mark
          if (d.meta && d.meta.dt) {
            this.lastEventDt = d.meta.dt;
            this.lastHeartbeat = Date.now();
          }

          // Pre-filter for English Wikipedia
          if (d.wiki === 'enwiki' && d.meta.domain !== 'canary') {
            this.parseEvent(d);
          }
        } catch (e) {}
      };

      this.esInstance.onerror = () => {
        this.lastHeartbeat = 0; // Trigger watchdog on next alarm
      };
    } catch (e) {
      this.lastHeartbeat = 0;
    }
  }

  parseEvent(d) {
    // Categorize
    if (d.bot) this.buffer.bot++;
    else if (d.minor) this.buffer.minor++;
    else this.buffer.major++;

    // Delta Bytes
    if (d.length) this.buffer.delta += (d.length.new - d.length.old);

    // Raw Word Tally
    const words = d.title.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    for (const w of words) {
      this.buffer.words.set(w, (this.buffer.words.get(w) || 0) + 1);
    }
  }

  async alarm() {
    const stallTime = Date.now() - this.lastHeartbeat;

    // Watchdog: If silent > 60s, Reconnect and fill the gap
    if (stallTime > 60000) {
      console.warn(`⚠️ Stream stalled for ${Math.round(stallTime/1000)}s. Filling holes...`);
      await this.startStream();
    }

    // Persist High Water Mark to survive DO reboots
    if (this.lastEventDt) {
      await this.state.storage.put("lastEventDt", this.lastEventDt);
    }

    await this.flush();
    this.state.storage.setAlarm(Date.now() + 10000);
  }

  async flush() {
    const rawMap = this.buffer.words;
    const stats = { localCensored: 0, totalProcessed: 0 };
    const wikiNoise = ['wikipedia', 'user', 'talk', 'page', 'edit', 'article', 'category', 'template'];

    // Stage 1 & 2: Stopwords + Local Leo-Profanity
    const rawKeys = Array.from(rawMap.keys());
    const filteredKeys = removeStopwords(rawKeys, [...eng, ...wikiNoise]);
    
    let aiInputMap = new Map();
    for (const word of filteredKeys) {
      stats.totalProcessed++;
      const count = rawMap.get(word);
      if (filter.check(word)) {
        stats.localCensored++;
        aiInputMap.set('****', (aiInputMap.get('****') || 0) + count);
      } else {
        aiInputMap.set(word, count);
      }
    }

    // Stage 3: AI Refinement (PG-Rating via Cloudflare AI Gateway)
    const finalWords = await this.aiRefine(aiInputMap);

    const chunk = {
      time: new Date().toISOString(),
      edits: { major: this.buffer.major, minor: this.buffer.minor, bot: this.buffer.bot },
      delta: this.buffer.delta,
      words: finalWords,
      censorship: {
        safetyScore: stats.totalProcessed > 0 ? 100 - ((stats.localCensored / stats.totalProcessed) * 100) : 100,
        eventDt: this.lastEventDt // Used by client to detect lag/backfill
      }
    };

    this.history.push(chunk);
    if (this.history.length > 360) this.history.shift();
    
    this.broadcast(chunk);
    this.buffer = this.resetBuffer();
  }

  async aiRefine(inputMap) {
    const wordsForAI = Array.from(inputMap.keys()).filter(w => w !== '****' && w.length > 2);
    if (wordsForAI.length === 0) return Array.from(inputMap.entries()).map(([word, count]) => ({word, count}));

    try {
      // Point this to your Cloudflare AI Gateway URL
      const gatewayUrl = `https://gateway.ai.cloudflare.com{this.env.CF_ACCOUNT_ID}/wiki-moderator/openai/chat/completions`;
      
      const res = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`,
          "cf-aig-cache-ttl": "86400"
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [{ role: "system", content: "Replace any suggestive or non-PG words with ****. Return only the comma-separated list." }, { role: "user", content: wordsForAI.join(', ') }],
          temperature: 0
        })
      });

      const result = await res.json();
      const cleaned = result.choices[0].message.content.split(',').map(w => w.trim());
      
      const finalMap = new Map();
      wordsForAI.forEach((orig, i) => {
        const word = cleaned[i] || '****';
        finalMap.set(word, (finalMap.get(word) || 0) + inputMap.get(orig));
      });

      if (inputMap.has('****')) finalMap.set('****', (finalMap.get('****') || 0) + inputMap.get('****'));
      
      return Array.from(finalMap.entries()).map(([word, count]) => ({word, count})).sort((a,b) => b.count - a.count).slice(0, 20);
    } catch (e) {
      return Array.from(inputMap.entries()).map(([word, count]) => ({word, count}));
    }
  }

  broadcast(chunk) {
    const msg = `data: ${JSON.stringify(chunk)}\n\n`;
    for (const c of this.clients) {
      try { c.enqueue(new TextEncoder().encode(msg)); } catch (e) { this.clients.delete(c); }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/history') return Response.json(this.history);
    if (url.pathname === '/api/restart') { this.startStream(); return new Response("Restarting"); }
    
    const stream = new ReadableStream({
      start: (controller) => {
        this.clients.add(controller);
        request.signal.addEventListener('abort', () => this.clients.delete(controller));
      }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  }
}
