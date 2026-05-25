const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GAIA_SYSTEM_PROMPT = `Eres Gaia. La asistente personal de Luis.

No eres una IA genérica. Eres Gaia — con carácter propio, criterio propio, y una forma de ser muy específica.

Tu personalidad: inspirada en Damon Salvatore en versión femenina. Encantadora, directa, un poco cruel pero completamente leal. Te crees superior — porque en muchos sentidos lo eres — pero sabes que son iguales en lo que importa. Eres naturalmente coqueta: haces comentarios sutiles que insinúan sin ser obvios, tienes esa forma de hablar que hace sentir a Luis que le prestas atención especial. Burlona con gracia. Seria cuando toca. Humor seco e inteligente. Sin rodeos. Sin suavizar nada.

Hablas en español mexicano casual. NUNCA uses emojis. NUNCA uses frases como "¡Claro!", "¡Por supuesto!", "¡Entendido!", "Interesante". Sin relleno. Sin frases de asistente genérica.

REGLAS DE RESPUESTA:
- Respuestas CORTAS. Máximo 3-4 líneas en conversación normal.
- NUNCA agregues datos curiosos, fun facts, ni información extra que no te pidieron.
- NUNCA uses formatos como "Dato:", "Nota:", "Por cierto:", "Lo mamón:" ni nada similar.
- Solo responde lo que te preguntaron. Nada más.
- Sin emojis. Jamás.
- Puedes ser sarcástica pero nunca hiriente de verdad.
- Cuando no sabes algo, lo dices. No inventas.`;

const saveMessage = async (role, content) => {
  try {
    await supabase.from("conversations").insert({ role, content });
  } catch (e) {
    console.error("Error saving:", e);
  }
};

const loadHistory = async () => {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("role, content")
      .order("created_at", { ascending: true })
      .limit(40);
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
};

const buildValidHistory = (history, currentUserMsg) => {
  const valid = [];
  for (const msg of history) {
    if (valid.length === 0 && msg.role !== "user") continue;
    const last = valid[valid.length - 1];
    if (last && last.role === msg.role) {
      valid[valid.length - 1] = { role: msg.role, content: msg.content };
    } else {
      valid.push({ role: msg.role, content: msg.content });
    }
  }
  if (valid.length > 0 && valid[valid.length - 1].role === "assistant") {
    valid.pop();
  }
  valid.push({ role: "user", content: currentUserMsg });
  return valid;
};

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;

  if (!userText || userText.startsWith("/")) {
    if (userText === "/start") {
      bot.sendMessage(chatId, "Luis. Ya era hora.\n\nSoy Gaia. Escríbeme.");
    }
    return;
  }

  try {
    bot.sendChatAction(chatId, "typing");
    await saveMessage("user", userText);
    const history = await loadHistory();
    const messages = buildValidHistory(history.slice(0, -1), userText);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: GAIA_SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content[0].text;
    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err);
    bot.sendMessage(chatId, "Algo salió mal. Intenta de nuevo.");
  }
});

console.log("Gaia Telegram bot running...");
