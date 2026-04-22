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

    // 1. Inicializar auth y doc (necesario para comandos y para IA)
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // 2. Manejo de comandos (ej. /resumen)
    if (text.startsWith('/resumen')) {
        const ahora = new Date();
        const hoyStr = ahora.toLocaleDateString('es-MX');
        const hoyDia = ahora.getDate();
        const esteMes = ahora.getMonth();
        const esteAnio = ahora.getFullYear();

        // Lógica de quincena: 1-15 o 16-fin de mes
        const esSegundaQuincena = hoyDia > 15;
        const inicioQuincena = esSegundaQuincena ? 16 : 1;
        const finQuincena = esSegundaQuincena ? 31 : 15;

        const gastosHoy = rows.filter(r => r.get('Fecha') === hoyStr);
        const totalHoy = gastosHoy.reduce((acc, r) => acc + Number(r.get('Monto') || 0), 0);

        const gastosQuincena = rows.filter(r => {
            const [d, m, y] = r.get('Fecha').split('/').map(Number);
            const fechaGasto = new Date(y, m - 1, d);
            return fechaGasto.getMonth() === esteMes && 
                   fechaGasto.getFullYear() === esteAnio && 
                   d >= inicioQuincena && d <= finQuincena;
        });

        const totalQuincenaSalidas = gastosQuincena
            .filter(r => r.get('Bolsa') === 'salidas')
            .reduce((acc, r) => acc + Number(r.get('Monto') || 0), 0);
        
        const totalQuincenaFija = gastosQuincena
            .filter(r => r.get('Bolsa') === 'fija')
            .reduce((acc, r) => acc + Number(r.get('Monto') || 0), 0);

        const ultimoGasto = rows.length > 0 ? rows[rows.length - 1] : null;
        const presupuestoQuincena = 1500;
        const restanteQuincena = presupuestoQuincena - totalQuincenaSalidas;

        let reply = `📊 *RESUMEN QUINCENAL (${inicioQuincena}-${finQuincena})*\n\n`;
        reply += `📅 *Hoy:* $${totalHoy}\n`;
        reply += `🗓️ *Total quincena:* $${totalQuincenaSalidas + totalQuincenaFija}\n`;
        reply += `   • Salidas: $${totalQuincenaSalidas}\n`;
        reply += `   • Fija/Servicios: $${totalQuincenaFija}\n\n`;
        reply += `🏁 *Presupuesto salidas:* $${totalQuincenaSalidas} / $${presupuestoQuincena}\n`;
        reply += `💰 *Restante:* $${restanteQuincena > 0 ? restanteQuincena : 0}\n\n`;
        
        if (ultimoGasto) {
            reply += `🕒 *Último gasto:* $${ultimoGasto.get('Monto')} - ${ultimoGasto.get('Concepto')} (${ultimoGasto.get('Fecha')})`;
        }

        const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
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
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const systemPrompt = `Eres un extractor de gastos. Devuelve ÚNICAMENTE un JSON:
        {"monto": number, "concepto": "string", "bolsa": "salidas" | "fija"}.
        Si tiene "#fijo" o es servicio básico, la bolsa es "fija".`;
        
        // Usamos la estructura de contenido más robusta
        const result = await model.generateContent({
            contents: [{ 
                role: 'user', 
                parts: [{ text: `${systemPrompt}\n\nTexto: ${text}` }] 
            }]
        });

        const responseText = result.response.text().replace(/```json|```/g, "").trim();
        const data = JSON.parse(responseText);

        if (!data.monto || isNaN(data.monto)) {
            console.log("No se detectó monto, ignorando mensaje.");
            return res.status(200).send('OK');
        }

        // 3. Guardar en Google Sheets (Ya tenemos 'sheet' y 'rows' cargados arriba)
        await sheet.addRow({
            Fecha: new Date().toLocaleDateString('es-MX'),
            Usuario: message.from.first_name || 'Desconocido',
            Monto: data.monto,
            Concepto: data.concepto,
            Bolsa: data.bolsa
        });

        // Calculamos sobre los datos de la quincena actual para el mensaje de confirmación
        const ahora = new Date();
        const hoyDia = ahora.getDate();
        const esteMes = ahora.getMonth();
        const esteAnio = ahora.getFullYear();
        const esSegundaQuincena = hoyDia > 15;
        const inicioQ = esSegundaQuincena ? 16 : 1;
        const finQ = esSegundaQuincena ? 31 : 15;

        const totalSalidasQuincena = rows.filter(r => {
            const [d, m, y] = r.get('Fecha').split('/').map(Number);
            return m - 1 === esteMes && y === esteAnio && d >= inicioQ && d <= finQ && r.get('Bolsa') === 'salidas';
        }).reduce((acc, r) => acc + Number(r.get('Monto') || 0), 0) + (data.bolsa === 'salidas' ? Number(data.monto) : 0);

        const restante = 1500 - totalSalidasQuincena;
        
        const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
        const reply = `✅ *Anotado:* $${data.monto} - ${data.concepto}\n\n📊 *Salidas quincena:* $${totalSalidasQuincena} / $1,500\n💰 *Restante:* $${restante > 0 ? restante : 0}`;

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