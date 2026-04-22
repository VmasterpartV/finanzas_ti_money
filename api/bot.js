import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Solo POST permitido');

    const { message } = req.body;
    if (!message || String(message.chat.id) !== process.env.TELEGRAM_CHAT_ID) {
        return res.status(200).send('OK');
    }

    const text = message.text;
    if (!text) return res.status(200).send('OK');

    try {
        // --- AJUSTE 1: Nombre del modelo ---
        // Usamos el string exacto que espera la API v1
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const systemPrompt = `Eres un extractor de gastos. Recibe un texto y devuelve SIEMPRE un JSON con este formato:
        {"monto": number, "concepto": "string", "bolsa": "salidas" | "fija"}.
        Si el texto tiene "#fijo" o menciona renta, luz, agua, internet, la bolsa es "fija". De lo contrario es "salidas".`;
        
        // --- AJUSTE 2: Estructura del contenido ---
        // Pasamos el system prompt y el texto de forma más explícita
        const result = await model.generateContent(`${systemPrompt}\n\nTexto a procesar: ${text}`);
        const response = await result.response;
        const responseText = response.text().replace(/```json|```/g, "").trim();
        
        const data = JSON.parse(responseText);

        if (!data.monto) throw new Error("No se detectó monto");

        // 3. Google Sheets (Igual que antes)
        const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        await sheet.addRow({
            Fecha: new Date().toLocaleDateString('es-MX'),
            Usuario: message.from.first_name || 'Desconocido',
            Monto: data.monto,
            Concepto: data.concepto,
            Bolsa: data.bolsa
        });

        const rows = await sheet.getRows();
        const totalSalidas = rows
            .filter(r => r.get('Bolsa') === 'salidas')
            .reduce((acc, r) => acc + Number(r.get('Monto') || 0), 0);

        const restante = 1500 - totalSalidas;
        
        const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
        const reply = `✅ *Anotado:* $${data.monto} - ${data.concepto}\n\n📊 *Salidas quincena:* $${totalSalidas} / $1,500\n💰 *Restante:* $${restante > 0 ? restante : 0}`;

        await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: message.chat.id, 
                text: reply,
                parse_mode: 'Markdown'
            })
        });

        return res.status(200).json({ ok: true });

    } catch (error) {
        console.error('Error Detallado:', error);
        // Enviamos el error a Telegram para que sepas qué pasó sin entrar a Vercel
        const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
        await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: message.chat.id, 
                text: `❌ Error: ${error.message}` 
            })
        });
        return res.status(200).send('Error reportado');
    }
}