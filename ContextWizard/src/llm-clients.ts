import Perplexity from '@perplexity-ai/perplexity_ai';
import { GoogleGenAI } from "@google/genai";

const perplexityClient = new Perplexity({
    apiKey: process.env.PERPLEXITY_API_KEY || "",
});

const geminiClient = new GoogleGenAI({});

export const LLM_PROVIDER = process.env.LLM_PROVIDER || 'perplexity';
console.log(`🧠 LLM Clients initialized. Provider: ${LLM_PROVIDER}`);

export async function callPerplexityAPI(systemPrompt: string, userPrompt: string): Promise<string> {
    const completion = await perplexityClient.chat.completions.create({
        model: 'sonar',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0.2,
        top_p: 0.9,
    });

    const rawContent = completion.choices?.[0]?.message?.content;
    let improvedComment: string = "";

    if (typeof rawContent === "string") {
        improvedComment = rawContent;
    } else if (rawContent != null) {
        improvedComment = String(rawContent);
    }

    if (!improvedComment) {
        throw new Error("Empty response from Perplexity API");
    }

    return improvedComment;
}

export async function callGeminiAPI(systemPrompt: string, userPrompt: string): Promise<string> {
    const completion = await geminiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
            { role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] },
        ],
        config: {
            maxOutputTokens: 1500,
            temperature: 0.2,
            topP: 0.9,
        }
    });

    const improvedComment = completion.text;

    if (!improvedComment) {
        throw new Error("Empty response from Gemini API");
    }

    return improvedComment;
}