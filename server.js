import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
// Sirve el frontend estático
app.use(express.static('public'));

app.post('/api/research', async (req, res) => {
    const { query, gemini_key, asta_key } = req.body;
    
    if (!query || !gemini_key || !asta_key) {
        return res.status(400).json({ error: "Faltan parámetros." });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${gemini_key}`;
    const systemPrompt = "Eres un investigador de élite. Usa snippet_search obligatoriamente. Busca en inglés. Responde en español.";
    const toolsDef = [{
        function_declarations: [{
            name: "snippet_search",
            description: "Busca bibliografía en Asta.",
            parameters: {
                type: "OBJECT",
                properties: { query: { type: "STRING" }, limit: { type: "INTEGER" } },
                required: ["query"]
            }
        }]
    }];

    try {
        // PASO 1: Análisis de Gemini
        const payload1 = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            tools: toolsDef,
            tool_config: { function_calling_config: { mode: "ANY" } },
            contents: [{ role: "user", parts: [{ text: query }] }]
        };

        const r1 = await fetch(geminiUrl, { method: 'POST', body: JSON.stringify(payload1), headers: {'Content-Type': 'application/json'} });
        if (!r1.ok) throw new Error(`Fallo Gemini P1: ${await r1.text()}`);
        const data1 = await r1.json();
        
        const respPart = data1.candidates[0].content.parts[0];
        let search_q = query;
        if (respPart.functionCall) {
            search_q = respPart.functionCall.args.query || query;
        }

        // PASO 2: Transporte MCP Oficial
        console.log(`Buscando en Asta: ${search_q}`);
        const transport = new SSEClientTransport(new URL("https://asta-tools.allen.ai/mcp/v1"), {
            requestInit: { headers: { "x-api-key": asta_key } }
        });
        
        const client = new Client({ name: "Cloud-RAG", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);
        
        const mcpResult = await client.callTool({
            name: "snippet_search",
            arguments: { query: search_q, limit: 5 }
        });
        
        let snippets = [];
        if (mcpResult.content && mcpResult.content.length > 0) {
            try { snippets = JSON.parse(mcpResult.content[0].text); } 
            catch { snippets = mcpResult.content[0].text; }
        }

        // PASO 3: Redacción Final
        const contents = [
            { role: "user", parts: [{ text: query }] },
            { role: "model", parts: [respPart] },
            { role: "user", parts: [{ functionResponse: { name: "snippet_search", response: { results: snippets } } }] }
        ];

        const r2 = await fetch(geminiUrl, { 
            method: 'POST', 
            body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, tools: toolsDef, contents: contents }), 
            headers: {'Content-Type': 'application/json'} 
        });
        
        if (!r2.ok) throw new Error(`Fallo Gemini P2: ${await r2.text()}`);
        const data2 = await r2.json();
        
        res.json({ 
            markdown: data2.candidates[0].content.parts[0].text, 
            snippets_used: snippets, 
            gemini_query: search_q 
        });

    } catch (error) {
        console.error(error);
        res.status(502).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend online en puerto ${PORT}`));