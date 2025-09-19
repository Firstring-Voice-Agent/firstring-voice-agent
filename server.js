import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { XMLBuilder } from 'fast-xml-parser';
import http from 'http';

const {
  PORT = 8080,
  PUBLIC_BASE_URL,
  N8N_BASE,
  BUSINESS_ID = 'plumber_joes',
  BUSINESS_NAME = "Plumber Joe's",
  CAL_SUMMARY_PREFIX = 'Job',
  TWILIO_AUTH_TOKEN,
  // ASR
  DEEPGRAM_API_KEY,
  // TTS
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  // LLMs (pick one)
  ANTHROPIC_API_KEY,
  OPENAI_API_KEY,
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/healthz', (_, res) => res.send('ok'));

// ------------------ Twilio signature (optional) ------------------
function verifyTwilio(req) {
  if (!TWILIO_AUTH_TOKEN) return true;
  const url = `${PUBLIC_BASE_URL}/twilio/voice`;
  const params = Object.keys(req.body).sort().map(k => k + req.body[k]).join('');
  const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(url + params, 'utf8').digest('base64');
  const sig = req.headers['x-twilio-signature'];
  return sig === expected;
}

// ------------------ Voice webhook: return TwiML ------------------
app.post('/twilio/voice', (req, res) => {
  if (!verifyTwilio(req)) return res.status(403).send('Bad signature');
  // IMPORTANT: Twilio Media Streams need wss://
  const streamUrl = `${PUBLIC_BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/stream`;

  const xmlObj = {
    Response: {
      Connect: {
        Stream: {
          '@_url': streamUrl,
          Parameter: [{ '@_name': 'caller', '@_value': req.body.From || '' }]
        }
      }
    }
  };
  const builder = new XMLBuilder({ ignoreAttributes: false });
  const xml = builder.build(xmlObj);
  res.type('text/xml').send(xml);
});

// ------------------ TTS (ElevenLabs → μ-law 8k) ------------------
// We request ulaw_8000 so we can stream straight to Twilio with no conversion.
async function ttsSynthesize(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return new Uint8Array(0);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=ulaw_8000`;
  try {
    const r = await axios.post(
      url,
      { text, model_id: 'eleven_multilingual_v2' },
      { responseType: 'arraybuffer', headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    return new Uint8Array(r.data);
  } catch (e) {
    console.error('ElevenLabs TTS error', e?.response?.data || e.message);
    return new Uint8Array(0);
  }
}

function wsSendMedia(ws, mulawBytes) {
  const chunkSize = 160; // 20ms @ 8kHz
  for (let i = 0; i < mulawBytes.length; i += chunkSize) {
    const chunk = mulawBytes.slice(i, i + chunkSize);
    const msg = { event: 'media', media: { payload: Buffer.from(chunk).toString('base64') } };
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

// ------------------ n8n lead sink ------------------
async function postLeadToN8N(lead) {
  if (!N8N_BASE) return;
  try {
    await axios.post(`${N8N_BASE.replace(/\/$/,'')}/webhook/receptionist/lead_finalized`, lead, { timeout: 8000 });
  } catch (e) { console.error('n8n post error', e?.response?.data || e.message); }
}

// ------------------ LLM: Claude if set, else OpenAI ------------------
async function llmReply(prompt, system = 'Stay concise. Ask only what you need to book a job.') {
  try {
    if (ANTHROPIC_API_KEY) {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-3-haiku-20240307',
        max_tokens: 180,
        system,
        messages: [{ role: 'user', content: prompt }]
      }, { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }});
      return r.data?.content?.[0]?.text?.trim() || 'Got it.';
    }
    // fallback: OpenAI
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    return r.data.choices?.[0]?.message?.content?.trim() || 'Got it.';
  } catch (e) {
    console.error('LLM reply error', e?.response?.data || e.message);
    return 'Okay.';
  }
}

async function llmExtract(text) {
  const schema = `caller_name, suburb, job_type, urgency(one of: now,today,this_week,no_rush), preferred_time, call_summary`;
  const prompt = `Extract JSON with fields: ${schema}. Only return JSON.\n\nMessage:\n${text}`;
  try {
    if (ANTHROPIC_API_KEY) {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-3-haiku-20240307',
        max_tokens: 300,
        system: 'You output only strict JSON.',
        messages: [{ role: 'user', content: prompt }]
      }, { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }});
      const raw = r.data?.content?.[0]?.text?.trim() || '{}';
      return JSON.parse(raw);
    }
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role: 'system', content: 'You output only strict JSON.' }, { role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const raw = r.data.choices?.[0]?.message?.content?.trim() || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('llmExtract error', e?.response?.data || e.message);
    return { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0, 800) };
  }
}

// ------------------ WebSocket media bridge ------------------
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  const sessionId = uuidv4();
  const state = { id: sessionId, caller: '', fullTranscript: [] };

  // Deepgram streaming ASR
  const dgUrl = 'wss://api.deepgram.com/v1/listen?punctuate=true&model=enhanced&encoding=mulaw&sample_rate=8000';
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });

  async function speak(text) {
    const bytes = await ttsSynthesize(text);
    if (bytes?.length) wsSendMedia(ws, bytes);
  }

  dg.on('open', async () => {
    await speak(`Hi, this is FirstRing AI for ${BUSINESS_NAME}. How can I help you today?`);
  });

  dg.on('message', async (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const transcript = alt.transcript || '';
      if (msg.is_final && transcript) {
        state.fullTranscript.push(transcript);
        const reply = await llmReply(
          `Caller said: "${transcript}". Reply in one sentence as a helpful trades receptionist. Confirm details when you have enough info.`
        );
        await speak(reply);
      }
    } catch { /* ignore non-JSON pings */ }
  });

  dg.on('error', (e) => console.error('Deepgram WS error', e.message));

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        state.caller = msg.start?.customParameters?.caller || '';
      }
      if (msg.event === 'media') {
        const b64 = msg.media?.payload;
        if (b64 && dg.readyState === WebSocket.OPEN) dg.send(Buffer.from(b64, 'base64'));
      }
      if (msg.event === 'stop') {
        const text = state.fullTranscript.join(' ');
        const fields = await llmExtract(text || 'Caller hung up quickly.');
        const lead = {
          ...fields,
          caller_number: state.caller,
          channel: 'voice',
          business_id: BUSINESS_ID,
          business_name: BUSINESS_NAME,
          calendar_summary_prefix: CAL_SUMMARY_PREFIX,
          transcript_url: '',
          booking_link: '',
          agent_session_id: sessionId
        };
        await postLeadToN8N(lead);
        try { dg.close(); } catch {}
      }
    } catch (e) { console.error('WS message error', e.message); }
  });

  ws.on('close', () => { try { dg.close(); } catch {} });
});

// HTTP upgrade → /stream
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else socket.destroy();
});
server.listen(PORT, () => console.log('FirstRing (Deepgram+11Labs) on', PORT));
