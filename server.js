import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { XMLBuilder } from 'fast-xml-parser';

const {
  PORT = 8080,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  N8N_BASE,
  BUSINESS_ID = 'plumber_joes',
  BUSINESS_NAME = "Plumber Joe's",
  CAL_SUMMARY_PREFIX = 'Job',
  TWILIO_AUTH_TOKEN
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/healthz', (_, res) => res.send('ok'));

function verifyTwilio(req) {
  if (!TWILIO_AUTH_TOKEN) return true;
  const url = `${PUBLIC_BASE_URL}/twilio/voice`;
  const params = Object.keys(req.body).sort().map(k => k + req.body[k]).join('');
  const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(url + params, 'utf8').digest('base64');
  const sig = req.headers['x-twilio-signature'];
  return sig === expected;
}

/** Voice webhook → return TwiML that opens a Media Stream */
app.post('/twilio/voice', (req, res) => {
  if (!verifyTwilio(req)) return res.status(403).send('Bad signature');

  // IMPORTANT: use WSS for the media stream (Twilio requires wss://)
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
  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// --- Audio helpers (mu-law encode/decode) ---
function encodeLinearToMuLaw(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

async function ttsSynthesize(text) {
  try {
    const r = await axios.post('https://api.openai.com/v1/audio/speech', {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text
    }, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    // naive downsample to 8k for Twilio by skipping samples
    const pcm16 = new Int16Array(new Uint8Array(r.data).buffer);
    const step = 3; // ~24k -> 8k
    const mulaw = new Uint8Array(Math.floor(pcm16.length/step));
    for (let i=0, j=0; i<pcm16.length; i+=step, j++){
      const s = pcm16[i];
      mulaw[j] = encodeLinearToMuLaw(Math.max(-32768, Math.min(32767, s)));
    }
    return mulaw;
  } catch (e) {
    console.error('ttsSynthesize error', e?.response?.data || e.message);
    return new Uint8Array(0);
  }
}

function wsSendMedia(ws, mulawBytes) {
  const chunkSize = 160; // 20ms @ 8kHz
  for (let i=0; i<mulawBytes.length; i+=chunkSize) {
    const chunk = mulawBytes.slice(i, i+chunkSize);
    const msg = { event: 'media', media: { payload: Buffer.from(chunk).toString('base64') } };
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

async function postLeadToN8N(lead) {
  if (!N8N_BASE) return;
  try {
    await axios.post(`${N8N_BASE.replace(/\/$/,'')}/webhook/receptionist/lead_finalized`, lead, { timeout: 8000 });
  } catch (e) { console.error('n8n post error', e?.response?.data || e.message); }
}

async function llmExtract(text) {
  const prompt = `Extract JSON fields for a trades receptionist.
Fields: caller_name, suburb, job_type, urgency(one of: now,today,this_week,no_rush), preferred_time, call_summary.
ALWAYS output JSON only.

Message:
${text}`;
  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a precise information extractor.'},
        { role: 'user', content: prompt }
      ]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    const content = r.data.choices?.[0]?.message?.content?.trim() || '{}';
    return JSON.parse(content);
  } catch (e) {
    console.error('llmExtract error', e?.response?.data || e.message);
    return { caller_name: '', suburb: '', job_type: '', urgency: 'this_week', preferred_time: '', call_summary: text.slice(0,800) };
  }
}

// --- WebSocket server for Twilio Media Streams ---
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  const sessionId = uuidv4();
  const state = { id: sessionId, caller: '', fullTranscript: [] };

  // Connect to Deepgram streaming ASR
  const dgUrl = 'wss://api.deepgram.com/v1/listen?punctuate=true&model=enhanced&encoding=mulaw&sample_rate=8000';
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }});

  function speak(text) {
    return ttsSynthesize(text).then(bytes => wsSendMedia(ws, bytes));
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
        const prompt = `You are a polite trades receptionist. Reply in one sentence. Confirm details when you have enough info. Caller said: "${transcript}"`;
        try {
          const r = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            temperature: 0.3,
            messages: [
              { role: 'system', content: 'Stay concise. Ask only what you need to book a job.' },
              { role: 'user', content: prompt }
            ]
          }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
          const reply = r.data.choices?.[0]?.message?.content?.trim() || 'Got it.';
          await speak(reply);
        } catch (e) { console.error('LLM reply error', e?.response?.data || e.message); }
      }
    } catch (e) {
      // ignore non-JSON frames
    }
  });

  dg.on('error', (e) => { console.error('Deepgram WS error', e.message); });

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        state.caller = msg.start?.customParameters?.caller || '';
      }
      if (msg.event === 'media') {
        const b64 = msg.media?.payload;
        if (b64 && dg.readyState === WebSocket.OPEN) {
          const audioBuf = Buffer.from(b64, 'base64');
          dg.send(audioBuf); // raw mu-law bytes to Deepgram
        }
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
    } catch (e) {
      console.error('WS message error', e.message);
    }
  });

  ws.on('close', () => { try { dg.close(); } catch {} });
});

// HTTP upgrade
import http from 'http';
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else socket.destroy();
});
server.listen(PORT, () => console.log('FirstRing (Deepgram) on', PORT));
