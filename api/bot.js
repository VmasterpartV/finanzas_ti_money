import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Solo POST permitido');

    const { message } = req.body;

    // 1. Validar que el mensaje venga de tu grupo
    if (!message || String(message.chat.id) !== process.env.TELEGRAM_CHAT_ID) {
        return res.status(200).send('OK');
    }

    const text = message.text;
    if (!text) return res.status(200).send('OK');

    try {
        // 2. IA: Extraer datos con Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const systemPrompt = `Eres un extractor de gastos. Recibe un texto y devuelve SIEMPRE un JSON con este formato:
        {"monto": number, "concepto": "string", "bolsa": "salidas" | "fija"}.
        Si el texto tiene "#fijo" o menciona renta, luz, agua, internet, la bolsa es "fija". De lo contrario es "salidas".`;
        
        const result = await model.generateContent([systemPrompt, text]);
        const responseText = result.response.text().replace(/```json|```/g, "").trim();
        const data = JSON.parse(responseText);

        if (!data.monto) throw new Error("No se detectó monto");

        // 3. Google Sheets: Conectar
        const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        // 4. Guardar fila
        await sheet.addRow({
            Fecha: new Date().toLocaleDateString('es-MX'),
            Usuario: message.from.first_name || 'Desconocido',
            Monto: data.monto,
            Concepto: data.concepto,
            Bolsa: data.bolsa
        });

        // 5. Calcular cuánto falta para llegar a los 1500 (Salidas)
        const rows = await sheet.getRows();
        const totalSalidas = rows
            .filter(r => r.get('Bolsa') === 'salidas')
            .reduce((acc, r) => acc + Number(r.get('Monto') || 0), 0);

        const restante = 1500 - totalSalidas;
        
        // 6. Responder a Telegram
        const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
        const reply = `✅ *Anotado:* $${data.monto} - ${data.concepto}\n\n📊 *Salidas de la quincena:* $${totalSalidas} / $1,500\n💰 *Restante:* $${restante > 0 ? restante : 0}`;

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
        console.error('Error:', error);
        return res.status(200).send('Error procesado');
    }
}