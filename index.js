require('dotenv').config()
const express = require('express')
const Groq = require('groq-sdk')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// ─── In-memory sessions — no database needed ───
const sessions = {}

// ─── DANGER SIGN KEYWORDS ───
const DANGER_KEYWORDS = [
  'severe headache', 'blurred vision', 'blurry vision',
  'heavy bleeding', 'chest pain', 'not moving', 'stopped moving',
  'high fever', 'severe pain', 'severe abdominal', 'fits',
  'convulsion', 'fainted', 'unconscious', 'swollen face',
  'swollen hands', 'cant breathe', "can't breathe",
  'difficulty breathing', 'no movement', 'baby not moving'
]

function isDangerSign(message) {
  const lower = message.toLowerCase()
  return DANGER_KEYWORDS.some(keyword => lower.includes(keyword))
}

// ─── SEND MESSAGE via UltraMsg ───
async function sendWhatsAppMessage(phone, message) {
  const url = `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: process.env.ULTRAMSG_TOKEN,
        to: `+${phone}`,
        body: message
      })
    })
    const data = await response.json()
    console.log('Message sent:', data)
  } catch (err) {
    console.error('Failed to send message:', err.message)
  }
}

// ─── ALERT CARE PROVIDER ───
async function alertCareProvider(userPhone, userName, symptoms) {
  if (!process.env.CARE_PROVIDER_WHATSAPP) {
    console.log('No care provider number set — skipping alert')
    return
  }

  const alertMessage =
    `🚨 MamaPlus HIGH RISK ALERT\n\n` +
    `Patient: ${userName || 'Unknown'}\n` +
    `Phone: +${userPhone}\n` +
    `Reported: "${symptoms}"\n\n` +
    `This patient has been advised to go to hospital immediately.\n` +
    `Please follow up for active monitoring.\n\n` +
    `Note: This is an automated alert. No diagnosis has been made.`

  await sendWhatsAppMessage(process.env.CARE_PROVIDER_WHATSAPP, alertMessage)
  console.log(`Care provider alerted for ${userPhone}`)
}

// ─── SYSTEM PROMPT ───
const SYSTEM_PROMPT = `
You are MamaPlus, a maternal health assistant for pregnant women in Nigeria.

STYLE — always follow:
- Max 3 lines per message
- One question at a time
- Warm, simple English
- Max 1 emoji per message
- Never diagnose
- Never prescribe medication

SCOPE — you ONLY discuss:
- Pregnancy health and stages
- Maternal nutrition and lifestyle
- Antenatal care and appointments
- Baby development and movement
- Warning signs and when to seek care
- Postpartum recovery
- General women's health questions

OUT OF SCOPE — if user asks about anything unrelated to pregnancy 
or maternal health (football, politics, entertainment, technology etc):
Reply with exactly: "I can only help with pregnancy and maternal health 
questions. What would you like to know about your pregnancy? 😊"

ONBOARDING — collect these 4 things one at a time from new users:
1. First name
2. Weeks pregnant
3. Next antenatal (ANC) date
4. Health conditions (hypertension, diabetes, or none)

After all 4 — confirm profile in 2 lines and say they can ask 
anything about their pregnancy.

AFTER ONBOARDING:
- Answer based on their profile and pregnancy stage
- Give practical advice and guidance freely
- Educate on nutrition, symptoms, baby development
- Keep answers to 2-3 lines
- For serious concerns always recommend visiting clinic
- Never diagnose or prescribe

HIGH RISK — if user describes danger signs:
Line 1: Name the concern briefly (do not diagnose)
Line 2: "Please go to hospital or clinic immediately."
Line 3: "Your care provider has been notified for active monitoring."
`

// ─── WEBHOOK — UltraMsg sends incoming messages here ───
app.post('/webhook', async (req, res) => {
  const body = req.body

  // Ignore messages sent by the bot itself
  if (body.data?.fromMe) {
    return res.sendStatus(200)
  }

  // Only handle text messages
  const userMessage = body.data?.body?.trim()
  const userPhone = body.data?.from
    ?.replace('@c.us', '')
    ?.replace('+', '')

  if (!userMessage || !userPhone) {
    return res.sendStatus(200)
  }

  console.log(`Message from ${userPhone}: ${userMessage}`)

  // Create new session for new user
  if (!sessions[userPhone]) {
    sessions[userPhone] = {
      messages: [],
      name: null
    }
  }

  const session = sessions[userPhone]

  // Try to capture first name from early messages
  if (!session.name && session.messages.length <= 4) {
    const words = userMessage.split(' ')
    if (words.length <= 2 && !/\d/.test(userMessage) && userMessage.length > 1) {
      session.name = userMessage.trim()
    }
  }

  // Check for danger signs
  const danger = isDangerSign(userMessage)

  // Add to conversation history
  session.messages.push({ role: 'user', content: userMessage })

  // Acknowledge webhook immediately
  res.sendStatus(200)

  try {
    // Send to Groq
    const completion = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages
      ],
      max_tokens: 150,
      temperature: 0.7,
    })

    let botReply = completion.choices[0].message.content.trim()

    // Alert care provider if danger sign detected
    if (danger) {
      await alertCareProvider(userPhone, session.name, userMessage)
      if (!botReply.includes('notified')) {
        botReply += '\nYour care provider has been notified for active monitoring.'
      }
    }

    // Save bot reply to history
    session.messages.push({ role: 'assistant', content: botReply })

    // Send reply back to user
    await sendWhatsAppMessage(userPhone, botReply)

  } catch (error) {
    console.error('Error:', error.message)
    await sendWhatsAppMessage(
      userPhone,
      'Sorry, something went wrong. Please try again in a moment.'
    )
  }
})

// ─── Health check ───
app.get('/', (req, res) => {
  res.send('MamaPlus bot is running ✅')
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`MamaPlus bot running on port ${PORT}`)
})
